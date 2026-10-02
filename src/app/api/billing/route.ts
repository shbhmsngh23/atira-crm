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

    // A workspace created from the switcher (migration 046) starts with
    // its trial already over. Tell the UI so it can say "no plan yet"
    // rather than "your trial has ended".
    const { data: subMeta } = await ctx.supabase
      .from('account_subscriptions')
      .select('created_at')
      .eq('account_id', ctx.accountId)
      .maybeSingle<{ created_at: string }>();
    const trialEnd = state.subscription.trial_ends_at
      ? Date.parse(state.subscription.trial_ends_at)
      : NaN;
    const hadTrial =
      subMeta !== null &&
      Number.isFinite(trialEnd) &&
      trialEnd - Date.parse(subMeta.created_at) > 86_400_000;

    const [members, automations] = await Promise.all([
      countUsage(ctx.accountId, 'members'),
      countUsage(ctx.accountId, 'automations'),
    ]);

    return NextResponse.json({
      plan: state.plan,
      // The reason is an internal note for platform admins.
      subscription: { ...state.subscription, suspended_reason: null },
      usable: state.usable,
      trialDaysLeft: trialDaysLeft(state.subscription),
      hadTrial,
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
