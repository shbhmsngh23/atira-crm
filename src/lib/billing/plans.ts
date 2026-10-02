// ============================================================
// Billing domain — plans, subscription state and entitlements.
//
// Pure functions only (no Supabase, no fetch) so every rule that
// decides "may this account do X" is unit-tested in isolation. The
// server glue lives in ./server.ts; the Razorpay HTTP client in
// ./razorpay.ts.
// ============================================================

export type BillingCycle = 'monthly' | 'yearly';

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'halted'
  | 'cancelled';

export type PlanFeature = 'ai' | 'api' | 'flows';

export type PlanLimit = 'members' | 'automations';

/** A row of the `plans` table. `null` limits mean unlimited. */
export interface Plan {
  id: string;
  name: string;
  description: string | null;
  price_monthly_paise: number;
  price_yearly_paise: number;
  razorpay_plan_id_monthly: string | null;
  razorpay_plan_id_yearly: string | null;
  max_members: number | null;
  max_automations: number | null;
  feature_ai: boolean;
  feature_api: boolean;
  feature_flows: boolean;
  is_public: boolean;
  sort_order: number;
}

/** A row of the `account_subscriptions` table. */
export interface Subscription {
  account_id: string;
  plan_id: string;
  status: SubscriptionStatus;
  billing_cycle: BillingCycle | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  razorpay_subscription_id: string | null;
}

export const PLAN_COLUMNS =
  'id, name, description, price_monthly_paise, price_yearly_paise, razorpay_plan_id_monthly, razorpay_plan_id_yearly, max_members, max_automations, feature_ai, feature_api, feature_flows, is_public, sort_order';

export const SUBSCRIPTION_COLUMNS =
  'account_id, plan_id, status, billing_cycle, trial_ends_at, current_period_end, cancel_at_period_end, razorpay_subscription_id';

function isFuture(iso: string | null, now: Date): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t > now.getTime();
}

/**
 * Whether the account may use the product right now.
 *
 *   trialing  — until `trial_ends_at`
 *   active    — yes
 *   past_due  — yes: Razorpay is still retrying the card, so this is
 *               a grace period, not a lockout
 *   halted    — no: Razorpay gave up retrying (or the plan is paused)
 *   cancelled — until the end of the period already paid for
 */
export function isSubscriptionUsable(
  sub: Pick<Subscription, 'status' | 'trial_ends_at' | 'current_period_end'>,
  now: Date = new Date(),
): boolean {
  switch (sub.status) {
    case 'trialing':
      return isFuture(sub.trial_ends_at, now);
    case 'active':
    case 'past_due':
      return true;
    case 'cancelled':
      return isFuture(sub.current_period_end, now);
    case 'halted':
    default:
      return false;
  }
}

/** Whole days left in the trial, rounded up; 0 once it has ended. */
export function trialDaysLeft(
  sub: Pick<Subscription, 'status' | 'trial_ends_at'>,
  now: Date = new Date(),
): number | null {
  if (sub.status !== 'trialing' || !sub.trial_ends_at) return null;
  const ms = new Date(sub.trial_ends_at).getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / 86_400_000);
}

export function planHasFeature(plan: Plan, feature: PlanFeature): boolean {
  switch (feature) {
    case 'ai':
      return plan.feature_ai;
    case 'api':
      return plan.feature_api;
    case 'flows':
      return plan.feature_flows;
  }
}

export function planLimit(plan: Plan, limit: PlanLimit): number | null {
  return limit === 'members' ? plan.max_members : plan.max_automations;
}

/** True when adding `adding` more items keeps usage within the limit. */
export function isWithinLimit(
  limit: number | null,
  current: number,
  adding = 1,
): boolean {
  if (limit === null) return true;
  return current + adding <= limit;
}

/** The Razorpay plan id for a cycle, or null when not configured. */
export function razorpayPlanId(plan: Plan, cycle: BillingCycle): string | null {
  return cycle === 'monthly'
    ? plan.razorpay_plan_id_monthly
    : plan.razorpay_plan_id_yearly;
}

/** Look up which of our plans (and cycle) a Razorpay plan id belongs to. */
export function findPlanByRazorpayId(
  plans: Plan[],
  razorpayId: string,
): { plan: Plan; cycle: BillingCycle } | null {
  for (const plan of plans) {
    if (plan.razorpay_plan_id_monthly === razorpayId) {
      return { plan, cycle: 'monthly' };
    }
    if (plan.razorpay_plan_id_yearly === razorpayId) {
      return { plan, cycle: 'yearly' };
    }
  }
  return null;
}

/** Format paise as rupees, e.g. 199900 → "₹1,999". */
export function formatInr(paise: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: paise % 100 === 0 ? 0 : 2,
  }).format(paise / 100);
}

// ------------------------------------------------------------
// Razorpay subscription events → our subscription row
// ------------------------------------------------------------

/**
 * Razorpay subscription statuses mapped onto ours. `created` (checkout
 * opened, nothing paid or authorised yet) maps to null: it must not
 * change the account's state, otherwise opening the checkout and
 * walking away would end a trial.
 */
export function mapRazorpayStatus(status: string): SubscriptionStatus | null {
  switch (status) {
    case 'authenticated':
    case 'active':
      return 'active';
    case 'pending':
      return 'past_due';
    case 'halted':
    case 'paused':
      return 'halted';
    case 'cancelled':
    case 'completed':
    case 'expired':
      return 'cancelled';
    default:
      return null;
  }
}

/** The subset of a Razorpay subscription entity the webhook relies on. */
export interface RazorpaySubscriptionEntity {
  id: string;
  plan_id: string;
  status: string;
  current_end?: number | null;
  notes?: Record<string, unknown> | unknown[] | null;
}

export type SubscriptionUpdate = Pick<
  Subscription,
  | 'plan_id'
  | 'status'
  | 'billing_cycle'
  | 'current_period_end'
  | 'razorpay_subscription_id'
> &
  Partial<Pick<Subscription, 'cancel_at_period_end'>>;

/**
 * Decide how a Razorpay subscription event changes an account's row.
 * Returns null when the event must be ignored.
 *
 * The one subtle case is an event for a subscription other than the
 * one on file. That happens when a customer abandons one checkout and
 * completes another, or when a late event for an old subscription
 * arrives after a new one went live. Such an event may only take over
 * the row when it makes the account active; a stale "cancelled" or
 * "halted" for a subscription the account already replaced must never
 * lock out a paying customer.
 */
export function applyRazorpayEvent(
  current: Pick<Subscription, 'razorpay_subscription_id'> | null,
  entity: RazorpaySubscriptionEntity,
  plans: Plan[],
): SubscriptionUpdate | null {
  const status = mapRazorpayStatus(entity.status);
  if (!status) return null;

  const match = findPlanByRazorpayId(plans, entity.plan_id);
  if (!match) return null;

  const isSameSubscription =
    !current?.razorpay_subscription_id ||
    current.razorpay_subscription_id === entity.id;
  if (!isSameSubscription && status !== 'active') return null;

  const periodEnd =
    typeof entity.current_end === 'number' && entity.current_end > 0
      ? new Date(entity.current_end * 1000).toISOString()
      : null;

  const update: SubscriptionUpdate = {
    plan_id: match.plan.id,
    status,
    billing_cycle: match.cycle,
    current_period_end: periodEnd,
    razorpay_subscription_id: entity.id,
  };
  // A different subscription going live replaces the old one, so any
  // "cancel at period end" scheduled on the old one no longer applies.
  // For the same subscription the flag is left alone: a routine
  // `subscription.charged` must not undo a cancellation the customer
  // has already scheduled.
  if (!isSameSubscription || !current?.razorpay_subscription_id) {
    update.cancel_at_period_end = false;
  }
  return update;
}

/** Read `notes.account_id` off a Razorpay entity (notes may be `[]`). */
export function accountIdFromNotes(
  notes: RazorpaySubscriptionEntity['notes'],
): string | null {
  if (!notes || Array.isArray(notes)) return null;
  const id = notes.account_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
