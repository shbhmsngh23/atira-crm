import { describe, expect, it } from 'vitest';

import {
  accountIdFromNotes,
  applyRazorpayEvent,
  findPlanByRazorpayId,
  formatInr,
  isSubscriptionUsable,
  isWithinLimit,
  mapRazorpayStatus,
  planHasFeature,
  trialDaysLeft,
  type Plan,
} from './plans';

const NOW = new Date('2026-10-02T12:00:00Z');
const FUTURE = '2026-10-10T00:00:00Z';
const PAST = '2026-09-30T00:00:00Z';

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'growth',
    name: 'Growth',
    description: null,
    price_monthly_paise: 499900,
    price_yearly_paise: 4999000,
    razorpay_plan_id_monthly: 'plan_growth_m',
    razorpay_plan_id_yearly: 'plan_growth_y',
    max_members: 10,
    max_automations: 25,
    feature_ai: true,
    feature_api: true,
    feature_flows: true,
    is_public: true,
    sort_order: 2,
    ...overrides,
  };
}

const PLANS = [
  plan(),
  plan({
    id: 'starter',
    name: 'Starter',
    razorpay_plan_id_monthly: 'plan_starter_m',
    razorpay_plan_id_yearly: null,
    feature_ai: false,
  }),
];

describe('isSubscriptionUsable', () => {
  const base = { trial_ends_at: null, current_period_end: null };

  it('allows a trial until it ends', () => {
    expect(isSubscriptionUsable({ ...base, status: 'trialing', trial_ends_at: FUTURE }, NOW)).toBe(true);
    expect(isSubscriptionUsable({ ...base, status: 'trialing', trial_ends_at: PAST }, NOW)).toBe(false);
    expect(isSubscriptionUsable({ ...base, status: 'trialing' }, NOW)).toBe(false);
  });

  it('allows active and past_due (Razorpay is still retrying)', () => {
    expect(isSubscriptionUsable({ ...base, status: 'active' }, NOW)).toBe(true);
    expect(isSubscriptionUsable({ ...base, status: 'past_due' }, NOW)).toBe(true);
  });

  it('blocks halted', () => {
    expect(isSubscriptionUsable({ ...base, status: 'halted', current_period_end: FUTURE }, NOW)).toBe(false);
  });

  it('allows cancelled only until the paid period ends', () => {
    expect(isSubscriptionUsable({ ...base, status: 'cancelled', current_period_end: FUTURE }, NOW)).toBe(true);
    expect(isSubscriptionUsable({ ...base, status: 'cancelled', current_period_end: PAST }, NOW)).toBe(false);
    expect(isSubscriptionUsable({ ...base, status: 'cancelled' }, NOW)).toBe(false);
  });
});

describe('trialDaysLeft', () => {
  it('rounds up partial days', () => {
    expect(trialDaysLeft({ status: 'trialing', trial_ends_at: '2026-10-03T00:00:00Z' }, NOW)).toBe(1);
    expect(trialDaysLeft({ status: 'trialing', trial_ends_at: FUTURE }, NOW)).toBe(8);
  });

  it('is 0 after the trial and null when not trialing', () => {
    expect(trialDaysLeft({ status: 'trialing', trial_ends_at: PAST }, NOW)).toBe(0);
    expect(trialDaysLeft({ status: 'active', trial_ends_at: FUTURE }, NOW)).toBeNull();
  });
});

describe('limits and features', () => {
  it('treats null as unlimited', () => {
    expect(isWithinLimit(null, 10_000)).toBe(true);
  });

  it('allows up to and including the limit', () => {
    expect(isWithinLimit(3, 2)).toBe(true);
    expect(isWithinLimit(3, 3)).toBe(false);
    expect(isWithinLimit(0, 0)).toBe(false);
  });

  it('reads feature flags', () => {
    expect(planHasFeature(PLANS[1], 'ai')).toBe(false);
    expect(planHasFeature(PLANS[0], 'flows')).toBe(true);
  });
});

describe('formatInr', () => {
  it('formats paise as rupees with Indian grouping', () => {
    expect(formatInr(199900)).toBe('₹1,999');
    expect(formatInr(9999000)).toBe('₹99,990');
    expect(formatInr(12000000)).toBe('₹1,20,000');
  });
});

describe('mapRazorpayStatus', () => {
  it('maps every Razorpay status', () => {
    expect(mapRazorpayStatus('created')).toBeNull();
    expect(mapRazorpayStatus('authenticated')).toBe('active');
    expect(mapRazorpayStatus('active')).toBe('active');
    expect(mapRazorpayStatus('pending')).toBe('past_due');
    expect(mapRazorpayStatus('halted')).toBe('halted');
    expect(mapRazorpayStatus('paused')).toBe('halted');
    expect(mapRazorpayStatus('cancelled')).toBe('cancelled');
    expect(mapRazorpayStatus('completed')).toBe('cancelled');
    expect(mapRazorpayStatus('expired')).toBe('cancelled');
    expect(mapRazorpayStatus('something_new')).toBeNull();
  });
});

describe('findPlanByRazorpayId', () => {
  it('finds the plan and the cycle', () => {
    expect(findPlanByRazorpayId(PLANS, 'plan_growth_y')).toMatchObject({
      plan: { id: 'growth' },
      cycle: 'yearly',
    });
    expect(findPlanByRazorpayId(PLANS, 'plan_unknown')).toBeNull();
  });
});

describe('applyRazorpayEvent', () => {
  const entity = {
    id: 'sub_new',
    plan_id: 'plan_growth_m',
    status: 'active',
    current_end: 1_793_000_000,
  };

  it('activates a trial account', () => {
    expect(applyRazorpayEvent({ razorpay_subscription_id: null }, entity, PLANS)).toEqual({
      plan_id: 'growth',
      status: 'active',
      billing_cycle: 'monthly',
      current_period_end: new Date(1_793_000_000 * 1000).toISOString(),
      razorpay_subscription_id: 'sub_new',
      cancel_at_period_end: false,
    });
  });

  it('keeps a scheduled cancellation on routine events for the same subscription', () => {
    const update = applyRazorpayEvent({ razorpay_subscription_id: 'sub_new' }, entity, PLANS);
    expect(update).not.toBeNull();
    expect(update).not.toHaveProperty('cancel_at_period_end');
  });

  it('records a plan change from subscription.updated', () => {
    const update = applyRazorpayEvent(
      { razorpay_subscription_id: 'sub_new' },
      { ...entity, plan_id: 'plan_starter_m' },
      PLANS,
    );
    expect(update?.plan_id).toBe('starter');
  });

  it('lets a different subscription take over only when it activates', () => {
    const current = { razorpay_subscription_id: 'sub_old' };
    expect(applyRazorpayEvent(current, entity, PLANS)?.razorpay_subscription_id).toBe('sub_new');
    expect(applyRazorpayEvent(current, { ...entity, status: 'cancelled' }, PLANS)).toBeNull();
    expect(applyRazorpayEvent(current, { ...entity, status: 'halted' }, PLANS)).toBeNull();
  });

  it('applies a cancellation for the subscription on file', () => {
    const update = applyRazorpayEvent(
      { razorpay_subscription_id: 'sub_new' },
      { ...entity, status: 'cancelled' },
      PLANS,
    );
    expect(update?.status).toBe('cancelled');
  });

  it('ignores a non-activating event when no subscription is on file', () => {
    // e.g. a workspace moved to a hand-granted plan after its old
    // Razorpay subscription was cancelled, then a late event arrives.
    const none = { razorpay_subscription_id: null };
    expect(applyRazorpayEvent(none, { ...entity, status: 'cancelled' }, PLANS)).toBeNull();
    expect(applyRazorpayEvent(none, { ...entity, status: 'pending' }, PLANS)).toBeNull();
  });

  it('ignores created events and unknown plans', () => {
    expect(applyRazorpayEvent(null, { ...entity, status: 'created' }, PLANS)).toBeNull();
    expect(applyRazorpayEvent(null, { ...entity, plan_id: 'plan_other' }, PLANS)).toBeNull();
  });

  it('leaves the period end empty when Razorpay sends none', () => {
    const update = applyRazorpayEvent(null, { ...entity, current_end: null }, PLANS);
    expect(update?.current_period_end).toBeNull();
  });
});

describe('accountIdFromNotes', () => {
  it('reads account_id and tolerates the empty-array form', () => {
    expect(accountIdFromNotes({ account_id: 'acc-1' })).toBe('acc-1');
    expect(accountIdFromNotes([])).toBeNull();
    expect(accountIdFromNotes(null)).toBeNull();
    expect(accountIdFromNotes({ account_id: 42 })).toBeNull();
  });
});
