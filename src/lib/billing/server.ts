// ============================================================
// Billing gates for API routes.
//
//   const ctx = await requireRole('agent');
//   await requireUsableSubscription(ctx);          // trial/plan is live
//   await requireFeature(ctx, 'ai');               // plan includes AI
//   await requireWithinLimit(ctx, 'automations');  // room for one more
//
// Each throws `PaymentRequiredError` (HTTP 402), which
// `toErrorResponse` maps to `{ error, code }`. The public API maps it
// through its own envelope (see requireApiKey).
//
// Server only.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { PaymentRequiredError } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  PLAN_COLUMNS,
  SUBSCRIPTION_COLUMNS,
  isSubscriptionUsable,
  isWithinLimit,
  planHasFeature,
  planLimit,
  type Plan,
  type PlanFeature,
  type PlanLimit,
  type Subscription,
} from './plans';

export interface BillingState {
  plan: Plan;
  subscription: Subscription;
  usable: boolean;
}

interface BillingContext {
  supabase: SupabaseClient;
  accountId: string;
}

/**
 * Load the account's subscription and plan. Reads through the caller's
 * client: members can read their own account's row (RLS), and the
 * public API passes its service-role client.
 */
export async function loadBillingState(
  supabase: SupabaseClient,
  accountId: string,
): Promise<BillingState> {
  const { data: subscription, error: subErr } = await supabase
    .from('account_subscriptions')
    .select(SUBSCRIPTION_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle<Subscription>();
  if (subErr) {
    throw new Error(`Failed to load subscription: ${subErr.message}`);
  }
  if (!subscription) {
    // Every account gets a trial row on creation (migration 043). A
    // missing row means the account predates the migration and was not
    // backfilled — fail closed, with a message an operator can act on.
    throw new PaymentRequiredError(
      'This workspace has no subscription. Contact support.',
      'subscription_missing',
    );
  }

  const { data: plan, error: planErr } = await supabase
    .from('plans')
    .select(PLAN_COLUMNS)
    .eq('id', subscription.plan_id)
    .maybeSingle<Plan>();
  if (planErr || !plan) {
    throw new Error(
      `Failed to load plan '${subscription.plan_id}': ${planErr?.message ?? 'not found'}`,
    );
  }

  return { plan, subscription, usable: isSubscriptionUsable(subscription) };
}

export async function requireUsableSubscription(
  ctx: BillingContext,
): Promise<BillingState> {
  const state = await loadBillingState(ctx.supabase, ctx.accountId);
  if (!state.usable) {
    if (state.subscription.suspended_at) {
      throw new PaymentRequiredError(
        'This workspace has been suspended. Contact support.',
        'account_suspended',
      );
    }
    throw new PaymentRequiredError(
      state.subscription.status === 'trialing'
        ? 'Your free trial has ended. Choose a plan in Settings → Billing to continue.'
        : 'Your subscription is not active. Update it in Settings → Billing to continue.',
      'subscription_inactive',
    );
  }
  return state;
}

const FEATURE_LABEL: Record<PlanFeature, string> = {
  ai: 'AI replies',
  api: 'The API',
  flows: 'Chatbot flows',
};

export async function requireFeature(
  ctx: BillingContext,
  feature: PlanFeature,
): Promise<BillingState> {
  const state = await requireUsableSubscription(ctx);
  if (!planHasFeature(state.plan, feature)) {
    throw new PaymentRequiredError(
      `${FEATURE_LABEL[feature]} is not included in the ${state.plan.name} plan. Upgrade in Settings → Billing.`,
      'feature_not_in_plan',
    );
  }
  return state;
}

/** Current usage for a limit, counted with the service role. */
export async function countUsage(
  accountId: string,
  limit: PlanLimit,
): Promise<number> {
  const admin = supabaseAdmin();

  if (limit === 'automations') {
    const { count, error } = await admin
      .from('automations')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId);
    if (error) throw new Error(`Failed to count automations: ${error.message}`);
    return count ?? 0;
  }

  // Seats: current members plus unexpired, unaccepted invitations, so
  // a workspace can't hand out more links than it has seats.
  const [members, invites] = await Promise.all([
    admin
      .from('account_memberships')
      .select('user_id', { count: 'exact', head: true })
      .eq('account_id', accountId),
    admin
      .from('account_invitations')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString()),
  ]);
  if (members.error) {
    throw new Error(`Failed to count members: ${members.error.message}`);
  }
  if (invites.error) {
    throw new Error(`Failed to count invitations: ${invites.error.message}`);
  }
  return (members.count ?? 0) + (invites.count ?? 0);
}

const LIMIT_LABEL: Record<PlanLimit, string> = {
  members: 'team members (including pending invitations)',
  automations: 'automations',
};

export async function requireWithinLimit(
  ctx: BillingContext,
  limit: PlanLimit,
): Promise<BillingState> {
  const state = await requireUsableSubscription(ctx);
  const max = planLimit(state.plan, limit);
  if (max === null) return state;

  const used = await countUsage(ctx.accountId, limit);
  if (!isWithinLimit(max, used)) {
    throw new PaymentRequiredError(
      `The ${state.plan.name} plan allows ${max} ${LIMIT_LABEL[limit]}. Upgrade in Settings → Billing to add more.`,
      'plan_limit_reached',
    );
  }
  return state;
}
