import { describe, expect, it } from 'vitest';

import { buildSubscriptionUpdate, parseAdminAction } from './actions';

const NOW = new Date('2026-10-02T12:00:00Z');
const trial = {
  status: 'trialing' as const,
  trial_ends_at: '2026-10-05T12:00:00Z',
  razorpay_subscription_id: null,
  suspended_at: null,
};
const paying = {
  status: 'active' as const,
  trial_ends_at: null,
  razorpay_subscription_id: 'sub_1',
  suspended_at: null,
};

describe('parseAdminAction', () => {
  it('validates trial extensions', () => {
    expect(parseAdminAction({ action: 'extend_trial', days: 7 })).toEqual({
      action: 'extend_trial',
      days: 7,
    });
    expect(
      parseAdminAction({ action: 'extend_trial', days: 0 })
    ).toHaveProperty('error');
    expect(
      parseAdminAction({ action: 'extend_trial', days: 91 })
    ).toHaveProperty('error');
    expect(
      parseAdminAction({ action: 'extend_trial', days: 1.5 })
    ).toHaveProperty('error');
  });

  it('validates plan grants', () => {
    expect(parseAdminAction({ action: 'set_plan', plan_id: 'pro' })).toEqual({
      action: 'set_plan',
      plan_id: 'pro',
      until: null,
    });
    expect(
      parseAdminAction({
        action: 'set_plan',
        plan_id: 'pro',
        until: '2026-12-31',
      })
    ).toEqual({
      action: 'set_plan',
      plan_id: 'pro',
      until: '2026-12-31T00:00:00.000Z',
    });
    expect(
      parseAdminAction({ action: 'set_plan', plan_id: 'pro', until: 'soon' })
    ).toHaveProperty('error');
    expect(
      parseAdminAction({ action: 'set_plan', plan_id: 'trial' })
    ).toHaveProperty('error');
  });

  it('requires a reason to suspend', () => {
    expect(
      parseAdminAction({ action: 'suspend', reason: '  ' })
    ).toHaveProperty('error');
    expect(parseAdminAction({ action: 'suspend', reason: 'Spam' })).toEqual({
      action: 'suspend',
      reason: 'Spam',
    });
  });

  it('rejects unknown actions and bodies', () => {
    expect(parseAdminAction({ action: 'delete' })).toHaveProperty('error');
    expect(parseAdminAction(null)).toHaveProperty('error');
  });
});

describe('buildSubscriptionUpdate', () => {
  it('extends a running trial from its current end', () => {
    expect(
      buildSubscriptionUpdate({ action: 'extend_trial', days: 7 }, trial, NOW)
    ).toMatchObject({
      status: 'trialing',
      trial_ends_at: '2026-10-12T12:00:00.000Z',
    });
  });

  it('restarts an expired trial from now', () => {
    const expired = { ...trial, trial_ends_at: '2026-09-01T00:00:00Z' };
    expect(
      buildSubscriptionUpdate({ action: 'extend_trial', days: 7 }, expired, NOW)
    ).toMatchObject({
      trial_ends_at: '2026-10-09T12:00:00.000Z',
    });
  });

  it('grants a plan by hand, with or without an end date', () => {
    expect(
      buildSubscriptionUpdate(
        { action: 'set_plan', plan_id: 'pro', until: null },
        trial,
        NOW
      )
    ).toMatchObject({
      plan_id: 'pro',
      status: 'active',
      current_period_end: null,
      razorpay_subscription_id: null,
    });
    expect(
      buildSubscriptionUpdate(
        {
          action: 'set_plan',
          plan_id: 'pro',
          until: '2026-01-01T00:00:00.000Z',
        },
        trial,
        NOW
      )
    ).toHaveProperty('error');
  });

  it('refuses trials and grants while Razorpay is still charging', () => {
    expect(
      buildSubscriptionUpdate({ action: 'extend_trial', days: 7 }, paying, NOW)
    ).toHaveProperty('error');
    expect(
      buildSubscriptionUpdate(
        { action: 'set_plan', plan_id: 'pro', until: null },
        { ...paying, status: 'past_due' },
        NOW
      )
    ).toHaveProperty('error');
    // A cancelled Razorpay subscription no longer charges, so it's fine.
    expect(
      buildSubscriptionUpdate(
        { action: 'set_plan', plan_id: 'pro', until: null },
        { ...paying, status: 'cancelled' },
        NOW
      )
    ).not.toHaveProperty('error');
  });

  it('suspends and unsuspends, but not twice', () => {
    expect(
      buildSubscriptionUpdate(
        { action: 'suspend', reason: 'Spam' },
        paying,
        NOW
      )
    ).toEqual({
      suspended_at: NOW.toISOString(),
      suspended_reason: 'Spam',
    });
    const suspended = { ...paying, suspended_at: NOW.toISOString() };
    expect(
      buildSubscriptionUpdate(
        { action: 'suspend', reason: 'Spam' },
        suspended,
        NOW
      )
    ).toHaveProperty('error');
    expect(
      buildSubscriptionUpdate({ action: 'unsuspend' }, suspended, NOW)
    ).toEqual({
      suspended_at: null,
      suspended_reason: null,
    });
    expect(
      buildSubscriptionUpdate({ action: 'unsuspend' }, paying, NOW)
    ).toHaveProperty('error');
  });
});
