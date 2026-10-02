// ============================================================
// POST /api/billing/cancel — cancel at the end of the paid period.
// Admin+.
//
// Razorpay keeps the subscription active until the cycle ends and then
// sends `subscription.cancelled`, which the webhook records. Until then
// we only mark `cancel_at_period_end` so the Billing panel can say so.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { loadBillingState } from '@/lib/billing/server';
import { RazorpayError, cancelSubscriptionAtCycleEnd } from '@/lib/billing/razorpay';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function POST() {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(`admin:billingCancel:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { subscription } = await loadBillingState(ctx.supabase, ctx.accountId);
    const subscriptionId = subscription.razorpay_subscription_id;
    if (
      !subscriptionId ||
      (subscription.status !== 'active' && subscription.status !== 'past_due')
    ) {
      return NextResponse.json({ error: 'There is no paid plan to cancel' }, { status: 409 });
    }
    if (subscription.cancel_at_period_end) {
      return NextResponse.json({ cancelled: true });
    }

    await cancelSubscriptionAtCycleEnd(subscriptionId);

    // Members can't write their subscription row (RLS); the service role
    // records the scheduled cancellation.
    const { error } = await supabaseAdmin()
      .from('account_subscriptions')
      .update({ cancel_at_period_end: true })
      .eq('account_id', ctx.accountId)
      .eq('razorpay_subscription_id', subscriptionId);
    if (error) {
      // Razorpay already has the cancellation; the webhook at period end
      // will still record it. Log rather than tell the user it failed.
      console.error('[billing/cancel] local update failed:', error);
    }

    return NextResponse.json({ cancelled: true });
  } catch (err) {
    if (err instanceof RazorpayError) {
      console.error('[billing/cancel] Razorpay error:', err.status, err.message);
      return NextResponse.json(
        { error: err.message },
        { status: err.status === 503 ? 503 : 502 },
      );
    }
    return toErrorResponse(err);
  }
}
