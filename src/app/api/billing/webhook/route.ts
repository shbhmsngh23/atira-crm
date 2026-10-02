// ============================================================
// POST /api/billing/webhook — Razorpay subscription events.
//
// Public endpoint, authenticated by the `X-Razorpay-Signature` HMAC.
// The only writer of plan/status changes on `account_subscriptions`.
//
// Configure in Razorpay → Settings → Webhooks:
//   URL     https://<your-domain>/api/billing/webhook
//   Secret  same value as RAZORPAY_WEBHOOK_SECRET
//   Events  subscription.authenticated, .activated, .charged,
//           .pending, .halted, .paused, .resumed, .cancelled,
//           .completed, .updated
//
// Idempotent: each Razorpay event id is recorded in `billing_events`
// and a redelivery of an already-recorded event is acknowledged
// without being applied again. A failure to apply returns 500 so
// Razorpay retries.
// ============================================================

import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  PLAN_COLUMNS,
  accountIdFromNotes,
  applyRazorpayEvent,
  type Plan,
  type RazorpaySubscriptionEntity,
} from '@/lib/billing/plans';
import { verifyWebhookSignature } from '@/lib/billing/razorpay';

interface RazorpayWebhookBody {
  event?: string;
  payload?: {
    subscription?: { entity?: RazorpaySubscriptionEntity };
  };
}

export async function POST(request: Request) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[billing/webhook] RAZORPAY_WEBHOOK_SECRET is not set');
    return NextResponse.json({ error: 'Billing webhook not configured' }, { status: 503 });
  }

  const rawBody = await request.text();
  if (!verifyWebhookSignature(rawBody, request.headers.get('x-razorpay-signature'), secret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  let body: RazorpayWebhookBody;
  try {
    body = JSON.parse(rawBody) as RazorpayWebhookBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const event = typeof body.event === 'string' ? body.event : 'unknown';
  // Razorpay sends the event id as a header. Fall back to a hash of the
  // signed body so idempotency still holds if it is ever missing.
  const eventId =
    request.headers.get('x-razorpay-event-id') ??
    `body:${createHash('sha256').update(rawBody).digest('hex')}`;

  const admin = supabaseAdmin();

  const { data: seen } = await admin
    .from('billing_events')
    .select('id')
    .eq('razorpay_event_id', eventId)
    .maybeSingle();
  if (seen) return NextResponse.json({ ok: true, duplicate: true });

  const entity = body.payload?.subscription?.entity;
  let accountId: string | null = null;

  if (entity && event.startsWith('subscription.')) {
    accountId = accountIdFromNotes(entity.notes);
    if (!accountId) {
      const { data: owner } = await admin
        .from('account_subscriptions')
        .select('account_id')
        .eq('razorpay_subscription_id', entity.id)
        .maybeSingle<{ account_id: string }>();
      accountId = owner?.account_id ?? null;
    }

    if (accountId) {
      const [{ data: current, error: currentErr }, { data: plans, error: plansErr }] =
        await Promise.all([
          admin
            .from('account_subscriptions')
            .select('razorpay_subscription_id')
            .eq('account_id', accountId)
            .maybeSingle<{ razorpay_subscription_id: string | null }>(),
          admin.from('plans').select(PLAN_COLUMNS).returns<Plan[]>(),
        ]);
      if (currentErr || plansErr) {
        console.error('[billing/webhook] load failed:', currentErr ?? plansErr);
        return NextResponse.json({ error: 'Temporary failure' }, { status: 500 });
      }

      if (current) {
        const update = applyRazorpayEvent(current, entity, plans ?? []);
        if (update) {
          const { error } = await admin
            .from('account_subscriptions')
            .update(update)
            .eq('account_id', accountId);
          if (error) {
            console.error('[billing/webhook] update failed:', error);
            return NextResponse.json({ error: 'Temporary failure' }, { status: 500 });
          }
        }
      } else {
        // Account deleted (or notes pointing at an account this database
        // doesn't have, e.g. a test-mode webhook aimed at production).
        console.warn('[billing/webhook] no subscription row for account', accountId);
        accountId = null;
      }
    } else {
      console.warn('[billing/webhook] could not resolve account for', entity.id);
    }
  }

  const { error: logErr } = await admin.from('billing_events').insert({
    razorpay_event_id: eventId,
    event,
    account_id: accountId,
    payload: body,
  });
  // 23505 = a concurrent delivery of the same event logged it first.
  if (logErr && logErr.code !== '23505') {
    console.error('[billing/webhook] event log failed:', logErr);
  }

  return NextResponse.json({ ok: true });
}
