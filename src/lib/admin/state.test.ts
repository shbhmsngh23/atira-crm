import { describe, expect, it } from 'vitest';

import { isPlatformAdminUser, platformAdminEmails } from './auth';
import { accountState, computeStats } from './state';

const NOW = new Date('2026-10-02T12:00:00Z');
const FUTURE = '2026-10-05T00:00:00Z';
const FAR = '2026-12-01T00:00:00Z';
const PAST = '2026-09-01T00:00:00Z';

const base = {
  status: 'trialing' as const,
  trial_ends_at: FUTURE,
  current_period_end: null,
  cancel_at_period_end: false,
  razorpay_subscription_id: null,
  suspended_at: null,
};

describe('accountState', () => {
  it('distinguishes running and expired trials', () => {
    expect(accountState(base, NOW)).toBe('trial');
    expect(accountState({ ...base, trial_ends_at: PAST }, NOW)).toBe(
      'trial_expired'
    );
  });

  it('separates Razorpay plans from plans granted by hand', () => {
    const active = { ...base, status: 'active' as const };
    expect(
      accountState({ ...active, razorpay_subscription_id: 'sub_1' }, NOW)
    ).toBe('paid');
    expect(
      accountState(
        {
          ...active,
          razorpay_subscription_id: 'sub_1',
          cancel_at_period_end: true,
        },
        NOW
      )
    ).toBe('cancelling');
    expect(accountState(active, NOW)).toBe('manual');
    expect(accountState({ ...active, current_period_end: FAR }, NOW)).toBe(
      'manual'
    );
    expect(accountState({ ...active, current_period_end: PAST }, NOW)).toBe(
      'manual_expired'
    );
  });

  it('does not expire a Razorpay plan on its period end (Razorpay renews it)', () => {
    expect(
      accountState(
        {
          ...base,
          status: 'active',
          razorpay_subscription_id: 'sub_1',
          current_period_end: PAST,
        },
        NOW
      )
    ).toBe('paid');
  });

  it('maps the remaining statuses', () => {
    expect(accountState({ ...base, status: 'past_due' }, NOW)).toBe('past_due');
    expect(accountState({ ...base, status: 'halted' }, NOW)).toBe('halted');
    expect(
      accountState(
        { ...base, status: 'cancelled', current_period_end: FUTURE },
        NOW
      )
    ).toBe('cancelling');
    expect(
      accountState(
        { ...base, status: 'cancelled', current_period_end: PAST },
        NOW
      )
    ).toBe('cancelled');
  });

  it('puts suspension above everything else', () => {
    expect(
      accountState(
        {
          ...base,
          status: 'active',
          razorpay_subscription_id: 'sub_1',
          suspended_at: PAST,
        },
        NOW
      )
    ).toBe('suspended');
  });
});

describe('computeStats', () => {
  const plans = [
    { id: 'starter', price_monthly_paise: 199900, price_yearly_paise: 1999000 },
    { id: 'growth', price_monthly_paise: 499900, price_yearly_paise: 4999000 },
  ];
  const row = (over: Partial<Parameters<typeof computeStats>[0][number]>) => ({
    ...base,
    plan_id: 'trial',
    billing_cycle: null,
    created_at: PAST,
    ...over,
  });

  it('adds up MRR from billing Razorpay plans only', () => {
    const stats = computeStats(
      [
        row({
          status: 'active',
          plan_id: 'starter',
          billing_cycle: 'monthly',
          razorpay_subscription_id: 'a',
        }),
        row({
          status: 'past_due',
          plan_id: 'growth',
          billing_cycle: 'yearly',
          razorpay_subscription_id: 'b',
        }),
        // Granted by hand: no MRR.
        row({ status: 'active', plan_id: 'growth' }),
        // Lapsed: no MRR.
        row({
          status: 'cancelled',
          plan_id: 'growth',
          billing_cycle: 'monthly',
          razorpay_subscription_id: 'c',
          current_period_end: PAST,
        }),
        row({
          suspended_at: PAST,
          status: 'active',
          plan_id: 'growth',
          billing_cycle: 'monthly',
          razorpay_subscription_id: 'd',
        }),
      ],
      plans,
      NOW
    );
    expect(stats.mrrPaise).toBe(199900 + Math.round(4999000 / 12));
    expect(stats.payingAccounts).toBe(2);
    expect(stats.byState.manual).toBe(1);
    expect(stats.byState.suspended).toBe(1);
  });

  it('counts new accounts and trials ending within 7 days', () => {
    const stats = computeStats(
      [
        row({ created_at: '2026-09-25T00:00:00Z' }),
        row({ trial_ends_at: FAR }),
        row({ trial_ends_at: PAST }),
      ],
      plans,
      NOW
    );
    expect(stats.totalAccounts).toBe(3);
    expect(stats.newLast30Days).toBe(1);
    expect(stats.trialsEndingIn7Days).toBe(1);
    expect(stats.byState.trial_expired).toBe(1);
  });
});

describe('platform admin check', () => {
  const allowed = platformAdminEmails(' Ops@Atira.in, founder@atira.in ,');

  it('parses the allow-list case-insensitively and ignores blanks', () => {
    expect([...allowed]).toEqual(['ops@atira.in', 'founder@atira.in']);
  });

  it('requires a listed and confirmed email', () => {
    expect(
      isPlatformAdminUser(
        { email: 'OPS@atira.in', email_confirmed_at: PAST },
        allowed
      )
    ).toBe(true);
    expect(
      isPlatformAdminUser(
        { email: 'ops@atira.in', email_confirmed_at: undefined },
        allowed
      )
    ).toBe(false);
    expect(
      isPlatformAdminUser(
        { email: 'someone@else.com', email_confirmed_at: PAST },
        allowed
      )
    ).toBe(false);
    expect(isPlatformAdminUser(null, allowed)).toBe(false);
  });

  it('allows nobody when the variable is unset', () => {
    expect(platformAdminEmails(undefined).size).toBe(0);
  });
});
