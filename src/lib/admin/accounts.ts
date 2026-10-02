// ============================================================
// Data access for the /admin console. Service role throughout:
// callers MUST have passed requirePlatformAdmin() first.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  PLAN_COLUMNS,
  SUBSCRIPTION_COLUMNS,
  type Plan,
  type Subscription,
} from '@/lib/billing/plans';
import { accountState, type AccountState } from './state';

export const PAGE_SIZE = 25;

export interface AdminAccountRow {
  id: string;
  name: string;
  createdAt: string;
  ownerEmail: string | null;
  members: number;
  whatsappConnected: boolean;
  planId: string;
  planName: string;
  state: AccountState;
  billingCycle: Subscription['billing_cycle'];
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
}

type SubscriptionRow = Subscription & { created_at: string };

/**
 * Strip characters that carry meaning in PostgREST filter syntax
 * (`,` `(` `)` separate `or=` terms, `%` `*` are wildcards) so a search
 * string can't change the shape of the query.
 */
export function sanitizeSearch(raw: string | null): string {
  return (raw ?? '')
    .replace(/[,()%*\\"]/g, ' ')
    .trim()
    .slice(0, 100);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Account ids whose name or any member's email matches `q`. */
async function searchAccountIds(q: string): Promise<string[]> {
  const admin = supabaseAdmin();
  const [byName, byEmail] = await Promise.all([
    admin.from('accounts').select('id').ilike('name', `%${q}%`).limit(200),
    admin.from('profiles').select('user_id').ilike('email', `%${q}%`).limit(200),
  ]);
  if (byName.error) throw new Error(`Account search failed: ${byName.error.message}`);
  if (byEmail.error) throw new Error(`Account search failed: ${byEmail.error.message}`);

  const ids = new Set<string>();
  for (const r of byName.data ?? []) ids.add(r.id as string);

  // A member may belong to several workspaces (migration 046).
  const userIds = (byEmail.data ?? []).map((r) => r.user_id as string);
  if (userIds.length > 0) {
    const { data, error } = await admin
      .from('account_memberships')
      .select('account_id')
      .in('user_id', userIds)
      .limit(500);
    if (error) throw new Error(`Account search failed: ${error.message}`);
    for (const r of data ?? []) ids.add(r.account_id as string);
  }

  if (UUID_RE.test(q)) ids.add(q.toLowerCase());
  return [...ids];
}

export async function listAccounts(input: {
  q: string;
  state: AccountState | null;
  page: number;
}): Promise<{ accounts: AdminAccountRow[]; total: number }> {
  const admin = supabaseAdmin();
  const now = `"${new Date().toISOString()}"`;

  let candidateIds: string[] | null = null;
  if (input.q) {
    candidateIds = await searchAccountIds(input.q);
    if (candidateIds.length === 0) return { accounts: [], total: 0 };
  }

  // account_subscriptions is 1:1 with accounts, so it's the list's
  // backbone: the state filter is a filter on its columns.
  let query = admin
    .from('account_subscriptions')
    .select(`${SUBSCRIPTION_COLUMNS}, created_at`, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((input.page - 1) * PAGE_SIZE, input.page * PAGE_SIZE - 1);

  if (candidateIds) query = query.in('account_id', candidateIds);

  if (input.state === 'suspended') {
    query = query.not('suspended_at', 'is', null);
  } else if (input.state) {
    query = query.is('suspended_at', null);
    switch (input.state) {
      case 'trial':
        query = query
          .eq('status', 'trialing')
          .gt('trial_ends_at', new Date().toISOString());
        break;
      case 'trial_expired':
        query = query
          .eq('status', 'trialing')
          .or(`trial_ends_at.is.null,trial_ends_at.lte.${now}`);
        break;
      case 'paid':
        query = query
          .eq('status', 'active')
          .not('razorpay_subscription_id', 'is', null)
          .eq('cancel_at_period_end', false);
        break;
      case 'cancelling':
        query = query.or(
          `and(status.eq.active,razorpay_subscription_id.not.is.null,cancel_at_period_end.eq.true),and(status.eq.cancelled,current_period_end.gt.${now})`
        );
        break;
      case 'manual':
        query = query
          .eq('status', 'active')
          .is('razorpay_subscription_id', null)
          .or(`current_period_end.is.null,current_period_end.gt.${now}`);
        break;
      case 'manual_expired':
        query = query
          .eq('status', 'active')
          .is('razorpay_subscription_id', null)
          .lte('current_period_end', new Date().toISOString());
        break;
      case 'past_due':
      case 'halted':
        query = query.eq('status', input.state);
        break;
      case 'cancelled':
        query = query
          .eq('status', 'cancelled')
          .or(`current_period_end.is.null,current_period_end.lte.${now}`);
        break;
    }
  }

  const { data: subs, count, error } = await query.returns<SubscriptionRow[]>();
  if (error) throw new Error(`Account list failed: ${error.message}`);
  if (!subs || subs.length === 0) return { accounts: [], total: count ?? 0 };

  const ids = subs.map((s) => s.account_id);
  const [accounts, memberships, configs, plans] = await Promise.all([
    admin
      .from('accounts')
      .select('id, name, owner_user_id, created_at')
      .in('id', ids),
    admin
      .from('account_memberships')
      .select('account_id')
      .in('account_id', ids),
    admin
      .from('whatsapp_config')
      .select('account_id, status')
      .in('account_id', ids),
    admin.from('plans').select('id, name'),
  ]);
  for (const r of [accounts, memberships, configs, plans]) {
    if (r.error) throw new Error(`Account list failed: ${r.error.message}`);
  }

  const ownerIds = [
    ...new Set((accounts.data ?? []).map((a) => a.owner_user_id as string)),
  ];
  const owners = ownerIds.length
    ? await admin.from('profiles').select('user_id, email').in('user_id', ownerIds)
    : { data: [], error: null };
  if (owners.error) throw new Error(`Account list failed: ${owners.error.message}`);

  const accountById = new Map(
    (accounts.data ?? []).map((a) => [
      a.id as string,
      a as {
        id: string;
        name: string;
        owner_user_id: string;
        created_at: string;
      },
    ])
  );
  const planName = new Map(
    (plans.data ?? []).map((p) => [p.id as string, p.name as string])
  );
  const members = new Map<string, number>();
  for (const m of memberships.data ?? []) {
    members.set(m.account_id as string, (members.get(m.account_id as string) ?? 0) + 1);
  }
  const emailByUser = new Map<string, string | null>();
  for (const p of owners.data ?? []) {
    emailByUser.set(p.user_id as string, (p.email as string | null) ?? null);
  }
  const connected = new Set(
    (configs.data ?? [])
      .filter((c) => c.status === 'connected')
      .map((c) => c.account_id as string)
  );

  const now2 = new Date();
  const rows: AdminAccountRow[] = subs.map((s) => {
    const account = accountById.get(s.account_id);
    return {
      id: s.account_id,
      name: account?.name ?? '(deleted)',
      createdAt: account?.created_at ?? s.created_at,
      ownerEmail: account
        ? (emailByUser.get(account.owner_user_id) ?? null)
        : null,
      members: members.get(s.account_id) ?? 0,
      whatsappConnected: connected.has(s.account_id),
      planId: s.plan_id,
      planName: planName.get(s.plan_id) ?? s.plan_id,
      state: accountState(s, now2),
      billingCycle: s.billing_cycle,
      trialEndsAt: s.trial_ends_at,
      currentPeriodEnd: s.current_period_end,
    };
  });

  return { accounts: rows, total: count ?? rows.length };
}

/** Every subscription row (paged through), for the dashboard numbers. */
export async function loadAllSubscriptions(): Promise<SubscriptionRow[]> {
  const admin = supabaseAdmin();
  const out: SubscriptionRow[] = [];
  const CHUNK = 1000;
  for (let from = 0; ; from += CHUNK) {
    const { data, error } = await admin
      .from('account_subscriptions')
      .select(`${SUBSCRIPTION_COLUMNS}, created_at`)
      .order('account_id')
      .range(from, from + CHUNK - 1)
      .returns<SubscriptionRow[]>();
    if (error) throw new Error(`Subscription scan failed: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < CHUNK) return out;
  }
}

export async function loadPlans(): Promise<Plan[]> {
  const { data, error } = await supabaseAdmin()
    .from('plans')
    .select(PLAN_COLUMNS)
    .order('sort_order')
    .returns<Plan[]>();
  if (error) throw new Error(`Plan load failed: ${error.message}`);
  return data ?? [];
}

export async function loadAccountDetail(accountId: string) {
  const admin = supabaseAdmin();
  const [account, subscription, members, config, audit, events] =
    await Promise.all([
      admin
        .from('accounts')
        .select('id, name, owner_user_id, created_at')
        .eq('id', accountId)
        .maybeSingle(),
      admin
        .from('account_subscriptions')
        .select(SUBSCRIPTION_COLUMNS)
        .eq('account_id', accountId)
        .maybeSingle<Subscription>(),
      admin
        .from('account_memberships')
        .select('user_id, role')
        .eq('account_id', accountId)
        .order('role'),
      admin
        .from('whatsapp_config')
        .select('status, phone_number_id, waba_id, connected_at')
        .eq('account_id', accountId)
        .maybeSingle(),
      admin
        .from('admin_audit_log')
        .select('id, actor_email, action, details, created_at')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(20),
      admin
        .from('billing_events')
        .select('id, event, created_at')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(20),
    ]);
  for (const r of [account, subscription, members, config, audit, events]) {
    if (r.error) throw new Error(`Account detail failed: ${r.error.message}`);
  }
  if (!account.data || !subscription.data) return null;

  const memberRows = (members.data ?? []) as { user_id: string; role: string }[];
  const { data: profiles, error: profileErr } = memberRows.length
    ? await admin
        .from('profiles')
        .select('user_id, full_name, email')
        .in(
          'user_id',
          memberRows.map((m) => m.user_id)
        )
    : { data: [], error: null };
  if (profileErr) throw new Error(`Account detail failed: ${profileErr.message}`);
  const profileById = new Map(
    (profiles ?? []).map((p) => [p.user_id as string, p as { full_name: string | null; email: string | null }])
  );

  return {
    account: account.data,
    subscription: subscription.data,
    state: accountState(subscription.data),
    members: memberRows.map((m) => ({
      user_id: m.user_id,
      full_name: profileById.get(m.user_id)?.full_name ?? null,
      email: profileById.get(m.user_id)?.email ?? null,
      account_role: m.role,
    })),
    whatsapp: config.data,
    audit: audit.data ?? [],
    billingEvents: events.data ?? [],
  };
}

export async function writeAudit(entry: {
  actorUserId: string;
  actorEmail: string;
  accountId: string;
  action: string;
  details: Record<string, unknown>;
}): Promise<void> {
  const { error } = await supabaseAdmin().from('admin_audit_log').insert({
    actor_user_id: entry.actorUserId,
    actor_email: entry.actorEmail,
    account_id: entry.accountId,
    action: entry.action,
    details: entry.details,
  });
  if (error) throw new Error(`Audit log write failed: ${error.message}`);
}
