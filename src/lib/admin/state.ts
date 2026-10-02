// ============================================================
// Platform admin view of a workspace's billing state, and the
// numbers on the /admin dashboard. Pure functions, unit-tested.
// ============================================================

import {
  isSubscriptionUsable,
  type Plan,
  type Subscription,
} from '@/lib/billing/plans';

/**
 * One label per workspace for the admin list. Finer-grained than the
 * subscription `status`: it separates a running trial from an expired
 * one, and a Razorpay plan from one granted by hand.
 */
export type AccountState =
  | 'suspended'
  | 'trial'
  | 'trial_expired'
  | 'paid'
  | 'cancelling'
  | 'manual'
  | 'manual_expired'
  | 'past_due'
  | 'halted'
  | 'cancelled';

export const ACCOUNT_STATES: readonly AccountState[] = [
  'trial',
  'trial_expired',
  'paid',
  'cancelling',
  'manual',
  'manual_expired',
  'past_due',
  'halted',
  'cancelled',
  'suspended',
];

type StateInput = Pick<
  Subscription,
  | 'status'
  | 'trial_ends_at'
  | 'current_period_end'
  | 'cancel_at_period_end'
  | 'razorpay_subscription_id'
  | 'suspended_at'
>;

export function accountState(
  sub: StateInput,
  now: Date = new Date()
): AccountState {
  if (sub.suspended_at) return 'suspended';
  const usable = isSubscriptionUsable(sub, now);
  switch (sub.status) {
    case 'trialing':
      return usable ? 'trial' : 'trial_expired';
    case 'active':
      if (!sub.razorpay_subscription_id)
        return usable ? 'manual' : 'manual_expired';
      return sub.cancel_at_period_end ? 'cancelling' : 'paid';
    case 'past_due':
      return 'past_due';
    case 'halted':
      return 'halted';
    case 'cancelled':
      return usable ? 'cancelling' : 'cancelled';
  }
}

export interface PlatformStats {
  totalAccounts: number;
  newLast30Days: number;
  byState: Record<AccountState, number>;
  /** Monthly recurring revenue from Razorpay plans, in paise. */
  mrrPaise: number;
  /** Paying through Razorpay (paid, cancelling with a Razorpay plan, past_due). */
  payingAccounts: number;
  trialsEndingIn7Days: number;
}

const DAY_MS = 86_400_000;

/**
 * MRR counts every Razorpay subscription that is still billing: paid,
 * past_due (Razorpay is retrying), and cancelling (paid up to the end
 * of the period). Yearly plans count as a twelfth of the yearly price.
 * Plans granted by hand are excluded: their price was agreed outside
 * the app.
 */
export function computeStats(
  rows: (StateInput & {
    plan_id: string;
    billing_cycle: Subscription['billing_cycle'];
    created_at: string;
  })[],
  plans: Pick<Plan, 'id' | 'price_monthly_paise' | 'price_yearly_paise'>[],
  now: Date = new Date()
): PlatformStats {
  const byState = Object.fromEntries(
    ACCOUNT_STATES.map((s) => [s, 0])
  ) as Record<AccountState, number>;
  const planById = new Map(plans.map((p) => [p.id, p]));
  let mrr = 0;
  let paying = 0;
  let trialsEnding = 0;
  let newAccounts = 0;

  for (const row of rows) {
    const state = accountState(row, now);
    byState[state] += 1;

    if (now.getTime() - new Date(row.created_at).getTime() <= 30 * DAY_MS)
      newAccounts += 1;

    if (state === 'trial' && row.trial_ends_at) {
      if (new Date(row.trial_ends_at).getTime() - now.getTime() <= 7 * DAY_MS)
        trialsEnding += 1;
    }

    const billing =
      row.razorpay_subscription_id !== null &&
      (state === 'paid' || state === 'past_due' || state === 'cancelling');
    if (billing) {
      paying += 1;
      const plan = planById.get(row.plan_id);
      if (plan) {
        mrr +=
          row.billing_cycle === 'yearly'
            ? Math.round(plan.price_yearly_paise / 12)
            : plan.price_monthly_paise;
      }
    }
  }

  return {
    totalAccounts: rows.length,
    newLast30Days: newAccounts,
    byState,
    mrrPaise: mrr,
    payingAccounts: paying,
    trialsEndingIn7Days: trialsEnding,
  };
}
