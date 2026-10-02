// ============================================================
// POST /api/billing/subscribe — { plan_id, cycle }        Admin+.
//
// No paid subscription yet (trial, lapsed, or cancelled): creates a
// Razorpay subscription and returns its hosted checkout URL. The
// account's row changes only when Razorpay confirms via the webhook,
// so abandoning the checkout leaves everything as it was.
//
// Paid subscription already running: switches it to the new plan
// in place (Razorpay prorates). The webhook records the change.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { loadBillingState } from '@/lib/billing/server';
import {
  PLAN_COLUMNS,
  razorpayPlanId,
  type BillingCycle,
  type Plan,
} from '@/lib/billing/plans';
import {
  RazorpayError,
  changeSubscriptionPlan,
  createSubscription,
} from '@/lib/billing/razorpay';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

function isCycle(value: unknown): value is BillingCycle {
  return value === 'monthly' || value === 'yearly';
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = await checkRateLimit(`admin:billingSubscribe:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      plan_id?: unknown;
      cycle?: unknown;
    } | null;
    const planId = typeof body?.plan_id === 'string' ? body.plan_id : '';
    const cycle = body?.cycle;
    if (!planId || !isCycle(cycle)) {
      return NextResponse.json(
        { error: "'plan_id' and 'cycle' ('monthly' or 'yearly') are required" },
        { status: 400 },
      );
    }

    const { data: plan } = await ctx.supabase
      .from('plans')
      .select(PLAN_COLUMNS)
      .eq('id', planId)
      .eq('is_public', true)
      .maybeSingle<Plan>();
    if (!plan) {
      return NextResponse.json({ error: 'Unknown plan' }, { status: 404 });
    }
    const rzpPlanId = razorpayPlanId(plan, cycle);
    if (!rzpPlanId) {
      return NextResponse.json(
        { error: `The ${plan.name} plan is not available for ${cycle} billing yet` },
        { status: 409 },
      );
    }

    const { subscription } = await loadBillingState(ctx.supabase, ctx.accountId);
    const hasRunningPaidPlan =
      subscription.razorpay_subscription_id !== null &&
      (subscription.status === 'active' || subscription.status === 'past_due');

    if (hasRunningPaidPlan) {
      if (subscription.cancel_at_period_end) {
        // Razorpay won't change the plan of a subscription that is set to
        // cancel, and starting a second one would bill twice for the
        // overlap.
        return NextResponse.json(
          {
            error:
              'Your current plan is set to cancel at the end of this billing period. Choose a new plan once it has ended.',
          },
          { status: 409 },
        );
      }
      if (subscription.plan_id === plan.id && subscription.billing_cycle === cycle) {
        return NextResponse.json({ error: 'You are already on this plan' }, { status: 409 });
      }
      await changeSubscriptionPlan(subscription.razorpay_subscription_id!, rzpPlanId);
      return NextResponse.json({ changed: true });
    }

    const created = await createSubscription({
      razorpayPlanId: rzpPlanId,
      cycle,
      accountId: ctx.accountId,
      planId: plan.id,
    });
    return NextResponse.json({ checkoutUrl: created.short_url });
  } catch (err) {
    if (err instanceof RazorpayError) {
      console.error('[billing/subscribe] Razorpay error:', err.status, err.message);
      return NextResponse.json(
        { error: err.message },
        { status: err.status === 503 ? 503 : 502 },
      );
    }
    return toErrorResponse(err);
  }
}
