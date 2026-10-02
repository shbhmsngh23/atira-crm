// ============================================================
// /api/admin/accounts/[id]                 Platform admins only.
//
//   GET  — workspace detail: members, WhatsApp connection, plan,
//          recent admin actions and Razorpay events.
//   POST — { action: 'extend_trial', days }
//          { action: 'set_plan', plan_id, until? }
//          { action: 'suspend', reason }
//          { action: 'unsuspend' }
//
// Every POST is written to admin_audit_log with the before/after
// values.
// ============================================================

import { NextResponse } from 'next/server';

import { requirePlatformAdmin } from '@/lib/admin/auth';
import { buildSubscriptionUpdate, parseAdminAction } from '@/lib/admin/actions';
import { loadAccountDetail, writeAudit } from '@/lib/admin/accounts';
import { toErrorResponse } from '@/lib/auth/account';
import { SUBSCRIPTION_COLUMNS, type Subscription } from '@/lib/billing/plans';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await requirePlatformAdmin();
    const { id } = await context.params;
    if (!UUID_RE.test(id))
      return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const detail = await loadAccountDetail(id);
    if (!detail)
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(detail);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const actor = await requirePlatformAdmin();
    const { id } = await context.params;
    if (!UUID_RE.test(id))
      return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const limit = checkRateLimit(
      `platformAdmin:${actor.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const action = parseAdminAction(await request.json().catch(() => null));
    if ('error' in action)
      return NextResponse.json({ error: action.error }, { status: 400 });

    const admin = supabaseAdmin();
    const { data: current, error: loadErr } = await admin
      .from('account_subscriptions')
      .select(SUBSCRIPTION_COLUMNS)
      .eq('account_id', id)
      .maybeSingle<Subscription>();
    if (loadErr)
      throw new Error(`Subscription load failed: ${loadErr.message}`);
    if (!current)
      return NextResponse.json({ error: 'Not found' }, { status: 404 });

    if (action.action === 'set_plan') {
      const { data: plan } = await admin
        .from('plans')
        .select('id')
        .eq('id', action.plan_id)
        .maybeSingle();
      if (!plan)
        return NextResponse.json({ error: 'Unknown plan' }, { status: 400 });
    }

    const update = buildSubscriptionUpdate(action, current);
    if ('error' in update)
      return NextResponse.json({ error: update.error }, { status: 409 });

    // Guarded on the values just read, so two admins acting at once
    // can't silently overwrite each other.
    let write = admin
      .from('account_subscriptions')
      .update(update)
      .eq('account_id', id)
      .eq('status', current.status);
    write =
      current.razorpay_subscription_id === null
        ? write.is('razorpay_subscription_id', null)
        : write.eq(
            'razorpay_subscription_id',
            current.razorpay_subscription_id
          );
    const { data: written, error: writeErr } = await write.select('account_id');
    if (writeErr)
      throw new Error(`Subscription update failed: ${writeErr.message}`);
    if (!written || written.length === 0) {
      return NextResponse.json(
        {
          error:
            'The subscription changed while you were editing it. Reload and try again.',
        },
        { status: 409 }
      );
    }

    const before = Object.fromEntries(
      Object.keys(update).map((k) => [k, current[k as keyof Subscription]])
    );
    await writeAudit({
      actorUserId: actor.userId,
      actorEmail: actor.email,
      accountId: id,
      action: action.action,
      details: { request: action, before, after: update },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
