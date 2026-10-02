'use client';

// ============================================================
// AdminConsole — /admin, for the people who run Atira CRM.
//
// Dashboard numbers, a searchable list of every workspace, and a
// side panel per workspace to extend a trial, grant a plan by hand
// (e.g. an agency deal), or suspend it. Every action is audited.
//
// Internal tool: English only, not in the message catalogues.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Search } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { formatInr } from '@/lib/billing/plans';
import {
  ACCOUNT_STATES,
  type AccountState,
  type PlatformStats,
} from '@/lib/admin/state';
import type { AdminAccountRow } from '@/lib/admin/accounts';

const STATE_LABEL: Record<AccountState, string> = {
  trial: 'Trial',
  trial_expired: 'Trial expired',
  paid: 'Paid',
  cancelling: 'Cancelling',
  manual: 'Granted',
  manual_expired: 'Grant expired',
  past_due: 'Payment due',
  halted: 'Payment failed',
  cancelled: 'Cancelled',
  suspended: 'Suspended',
};

const STATE_TONE: Record<
  AccountState,
  'secondary' | 'outline' | 'destructive'
> = {
  trial: 'secondary',
  trial_expired: 'outline',
  paid: 'secondary',
  cancelling: 'outline',
  manual: 'secondary',
  manual_expired: 'outline',
  past_due: 'destructive',
  halted: 'destructive',
  cancelled: 'outline',
  suspended: 'destructive',
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...init });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      (payload as { error?: string }).error || `Request failed (${res.status})`
    );
  return payload as T;
}

export function AdminConsole() {
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    getJson<{ isPlatformAdmin: boolean }>('/api/admin/me')
      .then((r) => setAllowed(r.isPlatformAdmin))
      .catch(() => setAllowed(false));
  }, []);

  if (allowed === null) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-10 text-sm">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (!allowed) {
    return (
      <p className="text-muted-foreground py-10 text-sm">
        This page doesn’t exist.
      </p>
    );
  }
  return <AdminConsoleInner />;
}

function AdminConsoleInner() {
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [rows, setRows] = useState<AdminAccountRow[]>([]);
  const [plans, setPlans] = useState<{ id: string; name: string }[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [submittedQ, setSubmittedQ] = useState('');
  const [state, setState] = useState<AccountState | ''>('');
  // The list is loading whenever the rows on screen belong to a
  // different query than the one selected.
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page) });
    if (submittedQ) params.set('q', submittedQ);
    if (state) params.set('state', state);
    return params.toString();
  }, [page, submittedQ, state]);
  const loading = loadedQuery !== query;

  const loadStats = useCallback(() => {
    getJson<{ stats: PlatformStats }>('/api/admin/stats')
      .then((r) => setStats(r.stats))
      .catch((err: Error) => toast.error(err.message));
  }, []);

  const loadRows = useCallback(() => {
    getJson<{
      accounts: AdminAccountRow[];
      total: number;
      pageSize: number;
      plans: { id: string; name: string }[];
    }>(`/api/admin/accounts?${query}`)
      .then((r) => {
        setRows(r.accounts);
        setTotal(r.total);
        setPageSize(r.pageSize);
        setPlans(r.plans);
      })
      .catch((err: Error) => toast.error(err.message))
      .finally(() => setLoadedQuery(query));
  }, [query]);

  useEffect(loadStats, [loadStats]);
  useEffect(loadRows, [loadRows]);

  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div>
      <h1 className="text-foreground text-2xl font-bold tracking-tight">
        Platform admin
      </h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Every Atira CRM workspace. Actions here are recorded in the audit log.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat
          label="Workspaces"
          value={stats?.totalAccounts}
          hint={stats ? `${stats.newLast30Days} new in 30 days` : undefined}
        />
        <Stat
          label="MRR"
          value={stats ? formatInr(stats.mrrPaise) : undefined}
          hint="Razorpay plans, excl. GST"
        />
        <Stat
          label="Paying"
          value={stats?.payingAccounts}
          hint={stats ? `${stats.byState.manual} granted by hand` : undefined}
        />
        <Stat
          label="On trial"
          value={stats?.byState.trial}
          hint={
            stats
              ? `${stats.trialsEndingIn7Days} ending within 7 days`
              : undefined
          }
        />
        <Stat
          label="Need attention"
          value={
            stats ? stats.byState.past_due + stats.byState.halted : undefined
          }
          hint="Payment due or failed"
        />
      </div>

      <form
        className="mt-6 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setSubmittedQ(q.trim());
        }}
      >
        <div className="min-w-[240px] flex-1">
          <Label htmlFor="admin-search" className="sr-only">
            Search
          </Label>
          <div className="relative">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input
              id="admin-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Workspace name, member email or account id"
              className="pl-8"
            />
          </div>
        </div>
        <select
          aria-label="Filter by state"
          value={state}
          onChange={(e) => {
            setPage(1);
            setState(e.target.value as AccountState | '');
          }}
          className="border-input bg-background h-9 rounded-lg border px-3 text-sm"
        >
          <option value="">All states</option>
          {ACCOUNT_STATES.map((s) => (
            <option key={s} value={s}>
              {STATE_LABEL[s]}
            </option>
          ))}
        </select>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>

      <Card className="mt-4">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-border text-muted-foreground border-b text-left text-xs uppercase">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Workspace</th>
                  <th className="px-4 py-2.5 font-medium">Plan</th>
                  <th className="px-4 py-2.5 font-medium">State</th>
                  <th className="px-4 py-2.5 font-medium">Ends / renews</th>
                  <th className="px-4 py-2.5 font-medium">Members</th>
                  <th className="px-4 py-2.5 font-medium">WhatsApp</th>
                  <th className="px-4 py-2.5 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="text-muted-foreground px-4 py-8 text-center"
                    >
                      <Loader2 className="inline size-4 animate-spin" />
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="text-muted-foreground px-4 py-8 text-center"
                    >
                      No workspaces match.
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr
                      key={r.id}
                      onClick={() => setSelected(r.id)}
                      className="border-border hover:bg-muted/50 cursor-pointer border-b last:border-0"
                    >
                      <td className="px-4 py-2.5">
                        <div className="text-foreground font-medium">
                          {r.name}
                        </div>
                        <div className="text-muted-foreground text-xs">
                          {r.ownerEmail ?? '—'}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        {r.planName}
                        {r.billingCycle ? (
                          <span className="text-muted-foreground">
                            {' '}
                            · {r.billingCycle}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge variant={STATE_TONE[r.state]}>
                          {STATE_LABEL[r.state]}
                        </Badge>
                      </td>
                      <td className="text-muted-foreground px-4 py-2.5">
                        {fmtDate(
                          r.state.startsWith('trial')
                            ? r.trialEndsAt
                            : r.currentPeriodEnd
                        )}
                      </td>
                      <td className="px-4 py-2.5">{r.members}</td>
                      <td className="px-4 py-2.5">
                        {r.whatsappConnected ? 'Connected' : '—'}
                      </td>
                      <td className="text-muted-foreground px-4 py-2.5">
                        {fmtDate(r.createdAt)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="text-muted-foreground mt-3 flex items-center justify-between text-sm">
        <span>
          {total} workspace{total === 1 ? '' : 's'}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <span>
            Page {page} of {pages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </div>

      <AccountPanel
        accountId={selected}
        plans={plans}
        onClose={() => setSelected(null)}
        onChanged={() => {
          loadRows();
          loadStats();
        }}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number | undefined;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-muted-foreground text-xs font-medium">{label}</div>
        <div className="text-foreground mt-1 text-2xl font-semibold">
          {value ?? '—'}
        </div>
        {hint ? (
          <div className="text-muted-foreground mt-0.5 text-xs">{hint}</div>
        ) : null}
      </CardContent>
    </Card>
  );
}

interface AccountDetail {
  account: { id: string; name: string; created_at: string };
  subscription: {
    plan_id: string;
    status: string;
    billing_cycle: string | null;
    trial_ends_at: string | null;
    current_period_end: string | null;
    razorpay_subscription_id: string | null;
    suspended_at: string | null;
    suspended_reason: string | null;
  };
  state: AccountState;
  members: {
    user_id: string;
    full_name: string | null;
    email: string | null;
    account_role: string;
  }[];
  whatsapp: {
    status: string;
    phone_number_id: string;
    waba_id: string | null;
    connected_at: string | null;
  } | null;
  audit: {
    id: string;
    actor_email: string;
    action: string;
    details: Record<string, unknown>;
    created_at: string;
  }[];
  billingEvents: { id: string; event: string; created_at: string }[];
}

function AccountPanel({
  accountId,
  plans,
  onClose,
  onChanged,
}: {
  accountId: string | null;
  plans: { id: string; name: string }[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<AccountDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [trialDays, setTrialDays] = useState('7');
  const [grantPlan, setGrantPlan] = useState('');
  const [grantUntil, setGrantUntil] = useState('');
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    if (!accountId) return;
    getJson<AccountDetail>(`/api/admin/accounts/${accountId}`)
      .then(setDetail)
      .catch((err: Error) => toast.error(err.message));
  }, [accountId]);

  useEffect(() => {
    setDetail(null);
    setReason('');
    setGrantUntil('');
    load();
  }, [load]);

  async function act(body: Record<string, unknown>, success: string) {
    if (!accountId) return;
    setBusy(true);
    try {
      await getJson(`/api/admin/accounts/${accountId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      toast.success(success);
      load();
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const sub = detail?.subscription;
  const paidPlans = plans.filter((p) => p.id !== 'trial');

  return (
    <Sheet
      open={accountId !== null}
      onOpenChange={(open) => (!open ? onClose() : undefined)}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{detail?.account.name ?? 'Workspace'}</SheetTitle>
          <SheetDescription className="font-mono text-xs">
            {accountId}
          </SheetDescription>
        </SheetHeader>

        {!detail || !sub ? (
          <div className="flex justify-center py-10">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          </div>
        ) : (
          <div className="space-y-6 px-4 pb-6 text-sm">
            <section>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={STATE_TONE[detail.state]}>
                  {STATE_LABEL[detail.state]}
                </Badge>
                <span className="font-medium">
                  {plans.find((p) => p.id === sub.plan_id)?.name ?? sub.plan_id}
                </span>
                {sub.billing_cycle ? (
                  <span className="text-muted-foreground">
                    · {sub.billing_cycle}
                  </span>
                ) : null}
              </div>
              <dl className="text-muted-foreground mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt>Trial ends</dt>
                <dd className="text-foreground">
                  {fmtDate(sub.trial_ends_at)}
                </dd>
                <dt>Period ends</dt>
                <dd className="text-foreground">
                  {fmtDate(sub.current_period_end)}
                </dd>
                <dt>Razorpay</dt>
                <dd className="text-foreground font-mono text-xs">
                  {sub.razorpay_subscription_id ?? '—'}
                </dd>
                <dt>WhatsApp</dt>
                <dd className="text-foreground">
                  {detail.whatsapp
                    ? `${detail.whatsapp.status} · number id ${detail.whatsapp.phone_number_id}`
                    : 'Not set up'}
                </dd>
                <dt>Created</dt>
                <dd className="text-foreground">
                  {fmtDate(detail.account.created_at)}
                </dd>
              </dl>
              {sub.suspended_at ? (
                <p className="bg-destructive/10 text-destructive mt-3 rounded-lg p-3">
                  Suspended {fmtDateTime(sub.suspended_at)}:{' '}
                  {sub.suspended_reason}
                </p>
              ) : null}
            </section>

            <section>
              <h3 className="text-foreground font-semibold">
                Members ({detail.members.length})
              </h3>
              <ul className="mt-2 space-y-1">
                {detail.members.map((m) => (
                  <li key={m.user_id} className="flex justify-between gap-3">
                    <span className="truncate">
                      {m.full_name || '—'}{' '}
                      <span className="text-muted-foreground">{m.email}</span>
                    </span>
                    <span className="text-muted-foreground capitalize">
                      {m.account_role}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="space-y-2">
              <h3 className="text-foreground font-semibold">
                Extend or restart trial
              </h3>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={90}
                  value={trialDays}
                  onChange={(e) => setTrialDays(e.target.value)}
                  className="w-24"
                  aria-label="Days"
                />
                <span className="text-muted-foreground">days</span>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      { action: 'extend_trial', days: Number(trialDays) },
                      'Trial updated'
                    )
                  }
                >
                  Apply
                </Button>
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-foreground font-semibold">
                Grant a plan by hand
              </h3>
              <p className="text-muted-foreground">
                For agency or offline deals. Not billed through Razorpay. Leave
                the date empty for no end date.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Plan"
                  value={grantPlan}
                  onChange={(e) => setGrantPlan(e.target.value)}
                  className="border-input bg-background h-9 rounded-lg border px-3 text-sm"
                >
                  <option value="">Choose plan…</option>
                  {paidPlans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <Input
                  type="date"
                  value={grantUntil}
                  onChange={(e) => setGrantUntil(e.target.value)}
                  className="w-40"
                  aria-label="Until"
                />
                <Button
                  size="sm"
                  disabled={busy || !grantPlan}
                  onClick={() =>
                    void act(
                      {
                        action: 'set_plan',
                        plan_id: grantPlan,
                        until: grantUntil || null,
                      },
                      'Plan granted'
                    )
                  }
                >
                  Grant
                </Button>
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-foreground font-semibold">
                {sub.suspended_at ? 'Lift suspension' : 'Suspend workspace'}
              </h3>
              {sub.suspended_at ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void act({ action: 'unsuspend' }, 'Suspension lifted')
                  }
                >
                  Unsuspend
                </Button>
              ) : (
                <>
                  <p className="text-muted-foreground">
                    Pauses sending, broadcasts, automations, AI and the API,
                    whatever the plan. Incoming messages are still saved. The
                    reason is visible only to platform admins.
                  </p>
                  <Textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Reason (required)"
                    rows={2}
                  />
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy || !reason.trim()}
                    onClick={() =>
                      void act(
                        { action: 'suspend', reason },
                        'Workspace suspended'
                      )
                    }
                  >
                    Suspend
                  </Button>
                </>
              )}
            </section>

            <section>
              <h3 className="text-foreground font-semibold">Admin activity</h3>
              {detail.audit.length === 0 ? (
                <p className="text-muted-foreground mt-2">None yet.</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {detail.audit.map((a) => (
                    <li key={a.id}>
                      <span className="font-medium">
                        {a.action.replace('_', ' ')}
                      </span>{' '}
                      <span className="text-muted-foreground">
                        by {a.actor_email} · {fmtDateTime(a.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="text-foreground font-semibold">Razorpay events</h3>
              {detail.billingEvents.length === 0 ? (
                <p className="text-muted-foreground mt-2">None yet.</p>
              ) : (
                <ul className={cn('mt-2 space-y-1 font-mono text-xs')}>
                  {detail.billingEvents.map((e) => (
                    <li key={e.id}>
                      {e.event}{' '}
                      <span className="text-muted-foreground">
                        · {fmtDateTime(e.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
