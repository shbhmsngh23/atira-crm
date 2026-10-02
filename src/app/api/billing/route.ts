// ============================================================
// GET /api/billing — the caller's plan, subscription, usage and the
// public plan catalogue. Any member (the Billing panel is read-only
// below admin).
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { countUsage, loadBillingState } from '@/lib/billing/server';
import { isRazorpayConfigured } from '@/lib/billing/razorpay';
import { PLAN_COLUMNS, trialDaysLeft, type Plan } from '@/lib/billing/plans';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const state = await loadBillingState(ctx.supabase, ctx.accountId);

    const { data: plans, error } = await ctx.supabase
      .from('plans')
      .select(PLAN_COLUMNS)
      .eq('is_public', true)
      .order('sort_order', { ascending: true })
      .returns<Plan[]>();
    if (error) {
      console.error('[billing] plans load error:', error);
      return NextResponse.json({ error: 'Failed to load plans' }, { status: 500 });
    }

    const [members, automations] = await Promise.all([
      countUsage(ctx.accountId, 'members'),
      countUsage(ctx.accountId, 'automations'),
    ]);

    return NextResponse.json({
      plan: state.plan,
      subscription: state.subscription,
      usable: state.usable,
      trialDaysLeft: trialDaysLeft(state.subscription),
      usage: { members, automations },
      // Razorpay plan ids are configuration, not something the browser
      // needs; expose only whether each cycle can be bought.
      plans: (plans ?? []).map(({ razorpay_plan_id_monthly, razorpay_plan_id_yearly, ...p }) => ({
        ...p,
        purchasable: {
          monthly: Boolean(razorpay_plan_id_monthly),
          yearly: Boolean(razorpay_plan_id_yearly),
        },
      })),
      checkoutEnabled: isRazorpayConfigured(),
      canManage: hasMinRole(ctx.role, 'admin'),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
