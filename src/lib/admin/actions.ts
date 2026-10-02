// ============================================================
// Platform admin actions on a workspace's subscription. Pure:
// validation and the resulting row update, unit-tested. The route
// (src/app/api/admin/accounts/[id]/route.ts) applies and audits them.
// ============================================================

import type { Subscription } from '@/lib/billing/plans';

export type AdminAction =
  | { action: 'extend_trial'; days: number }
  | { action: 'set_plan'; plan_id: string; until: string | null }
  | { action: 'suspend'; reason: string }
  | { action: 'unsuspend' };

export const MAX_TRIAL_EXTENSION_DAYS = 90;
const MAX_REASON_LEN = 500;

export function parseAdminAction(
  body: unknown
): AdminAction | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Invalid JSON body' };
  const b = body as Record<string, unknown>;

  switch (b.action) {
    case 'extend_trial': {
      const days = b.days;
      if (
        typeof days !== 'number' ||
        !Number.isInteger(days) ||
        days < 1 ||
        days > MAX_TRIAL_EXTENSION_DAYS
      ) {
        return {
          error: `'days' must be a whole number from 1 to ${MAX_TRIAL_EXTENSION_DAYS}`,
        };
      }
      return { action: 'extend_trial', days };
    }
    case 'set_plan': {
      if (typeof b.plan_id !== 'string' || !b.plan_id)
        return { error: "'plan_id' is required" };
      if (b.plan_id === 'trial')
        return { error: "Use 'extend_trial' to put a workspace on a trial" };
      let until: string | null = null;
      if (b.until !== undefined && b.until !== null && b.until !== '') {
        const t =
          typeof b.until === 'string' ? new Date(b.until).getTime() : NaN;
        if (!Number.isFinite(t)) return { error: "'until' must be a date" };
        until = new Date(t).toISOString();
      }
      return { action: 'set_plan', plan_id: b.plan_id, until };
    }
    case 'suspend': {
      const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
      if (!reason)
        return { error: 'A reason is required to suspend a workspace' };
      if (reason.length > MAX_REASON_LEN) {
        return {
          error: `Reason must be ${MAX_REASON_LEN} characters or fewer`,
        };
      }
      return { action: 'suspend', reason };
    }
    case 'unsuspend':
      return { action: 'unsuspend' };
    default:
      return {
        error: "'action' must be extend_trial, set_plan, suspend or unsuspend",
      };
  }
}

type Current = Pick<
  Subscription,
  'status' | 'trial_ends_at' | 'razorpay_subscription_id' | 'suspended_at'
>;

/** Razorpay is still charging this workspace. */
export function isBillingThroughRazorpay(sub: Current): boolean {
  return (
    sub.razorpay_subscription_id !== null &&
    (sub.status === 'active' || sub.status === 'past_due')
  );
}

/**
 * The row update for an action, or an error when it doesn't apply.
 *
 * Trials and hand-granted plans are refused while Razorpay is still
 * charging the workspace: the next Razorpay webhook would overwrite
 * them, and the customer would keep being charged for a plan the app
 * no longer shows. Cancel the Razorpay subscription first.
 */
export function buildSubscriptionUpdate(
  action: AdminAction,
  current: Current,
  now: Date = new Date()
): Partial<Subscription> | { error: string } {
  const DAY_MS = 86_400_000;

  switch (action.action) {
    case 'extend_trial': {
      if (isBillingThroughRazorpay(current)) {
        return {
          error:
            'This workspace is paying through Razorpay. Cancel that subscription before giving it a trial.',
        };
      }
      const currentEnd = current.trial_ends_at
        ? new Date(current.trial_ends_at).getTime()
        : 0;
      const from =
        current.status === 'trialing' && currentEnd > now.getTime()
          ? currentEnd
          : now.getTime();
      return {
        plan_id: 'trial',
        status: 'trialing',
        trial_ends_at: new Date(from + action.days * DAY_MS).toISOString(),
        billing_cycle: null,
        current_period_end: null,
        cancel_at_period_end: false,
        razorpay_subscription_id: null,
      };
    }
    case 'set_plan': {
      if (isBillingThroughRazorpay(current)) {
        return {
          error:
            'This workspace is paying through Razorpay. Cancel that subscription before granting a plan by hand.',
        };
      }
      if (action.until && new Date(action.until).getTime() <= now.getTime()) {
        return { error: "'until' must be in the future" };
      }
      return {
        plan_id: action.plan_id,
        status: 'active',
        billing_cycle: null,
        current_period_end: action.until,
        cancel_at_period_end: false,
        razorpay_subscription_id: null,
      };
    }
    case 'suspend':
      if (current.suspended_at)
        return { error: 'This workspace is already suspended' };
      return {
        suspended_at: now.toISOString(),
        suspended_reason: action.reason,
      };
    case 'unsuspend':
      if (!current.suspended_at)
        return { error: 'This workspace is not suspended' };
      return { suspended_at: null, suspended_reason: null };
  }
}
