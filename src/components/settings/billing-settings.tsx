'use client';

// ============================================================
// BillingSettings — Settings → Billing & plan
//
// Shows the workspace's plan, its status, usage against the plan's
// limits, and the plan catalogue. Admins and the owner can start a
// Razorpay checkout, switch plans or cancel; everyone else sees the
// same panel read-only.
//
// Checkout is Razorpay's hosted page (the subscription's short_url),
// so no Razorpay script runs inside the app. The plan only changes
// here once Razorpay's webhook confirms it.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Check, Loader2, Minus } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  formatInr,
  type BillingCycle,
  type Plan,
  type Subscription,
  type SubscriptionStatus,
} from '@/lib/billing/plans';
import { SettingsPanelHead } from './settings-panel-head';

type CatalogPlan = Omit<Plan, 'razorpay_plan_id_monthly' | 'razorpay_plan_id_yearly'> & {
  purchasable: Record<BillingCycle, boolean>;
};

interface BillingResponse {
  plan: Plan;
  subscription: Subscription;
  usable: boolean;
  trialDaysLeft: number | null;
  usage: { members: number; automations: number };
  plans: CatalogPlan[];
  checkoutEnabled: boolean;
  canManage: boolean;
}

const STATUS_BADGE: Record<SubscriptionStatus, 'secondary' | 'outline' | 'destructive'> = {
  trialing: 'secondary',
  active: 'secondary',
  past_due: 'destructive',
  halted: 'destructive',
  cancelled: 'outline',
};

export function BillingSettings() {
  const t = useTranslations('Billing');
  const format = useFormatter();

  const [data, setData] = useState<BillingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [cycle, setCycle] = useState<BillingCycle>('monthly');
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/billing', { cache: 'no-store' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('loadFailed'));
        return;
      }
      const next = payload as BillingResponse;
      setData(next);
      if (next.subscription.billing_cycle) setCycle(next.subscription.billing_cycle);
    } catch (err) {
      console.error('[BillingSettings] load error:', err);
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const fmtDate = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { year: 'numeric', month: 'short', day: 'numeric' }) : '';

  async function choosePlan(planId: string) {
    setPendingPlan(planId);
    try {
      const res = await fetch('/api/billing/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_id: planId, cycle }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('subscribeFailed'));
        return;
      }
      if (payload.checkoutUrl) {
        toast.message(t('redirecting'));
        window.location.assign(payload.checkoutUrl as string);
        return;
      }
      toast.success(t('changed'));
    } catch (err) {
      console.error('[BillingSettings] subscribe error:', err);
      toast.error(t('networkError'));
    } finally {
      setPendingPlan(null);
    }
  }

  async function cancelPlan() {
    setCancelling(true);
    try {
      const res = await fetch('/api/billing/cancel', { method: 'POST' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('cancelFailed'));
        return;
      }
      toast.success(t('cancelled', { date: fmtDate(data?.subscription.current_period_end ?? null) }));
      setCancelOpen(false);
      await load();
    } catch (err) {
      console.error('[BillingSettings] cancel error:', err);
      toast.error(t('networkError'));
    } finally {
      setCancelling(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t('loading')}
      </div>
    );
  }

  if (!data) {
    return <p className="py-10 text-sm text-muted-foreground">{t('loadFailed')}</p>;
  }

  const { plan, subscription, usage } = data;
  const isPaidAndRunning =
    subscription.razorpay_subscription_id !== null &&
    (subscription.status === 'active' || subscription.status === 'past_due');

  const suspended = subscription.suspended_at !== null;
  let statusLine: string;
  if (suspended) {
    statusLine = t('suspendedHint');
  } else if (subscription.status === 'trialing') {
    statusLine = t('trialEndsIn', { days: data.trialDaysLeft ?? 0 });
  } else if (subscription.status === 'cancelled' || subscription.cancel_at_period_end) {
    statusLine = data.usable
      ? t('endsOn', { date: fmtDate(subscription.current_period_end) })
      : t('endedOn', { date: fmtDate(subscription.current_period_end) });
  } else if (subscription.status === 'halted') {
    statusLine = t('haltedHint');
  } else if (subscription.status === 'past_due') {
    statusLine = t('pastDueHint');
  } else if (!subscription.razorpay_subscription_id) {
    // Granted by a platform admin, outside Razorpay.
    statusLine = subscription.current_period_end
      ? t('activeUntil', { date: fmtDate(subscription.current_period_end) })
      : t('manualPlan');
  } else {
    statusLine = t('renewsOn', { date: fmtDate(subscription.current_period_end) });
  }

  const usageLine = (used: number, limit: number | null, key: 'members' | 'automations') =>
    limit === null
      ? t(`usage.${key}Unlimited`, { used })
      : t(`usage.${key}`, { used, limit });

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('desc')} />

      <Card className="mb-6">
        <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t('currentPlan')}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="text-lg font-semibold text-foreground">{plan.name}</span>
              <Badge variant={suspended ? 'destructive' : STATUS_BADGE[subscription.status]}>
                {t(`status.${suspended ? 'suspended' : subscription.status}`)}
              </Badge>
              {subscription.billing_cycle ? (
                <span className="text-sm text-muted-foreground">
                  {t(subscription.billing_cycle)}
                </span>
              ) : null}
            </div>
            <p
              className={cn(
                'mt-1 text-sm',
                data.usable ? 'text-muted-foreground' : 'text-destructive',
              )}
            >
              {statusLine}
            </p>
            <ul className="mt-3 space-y-1 text-sm text-foreground">
              <li>{usageLine(usage.members, plan.max_members, 'members')}</li>
              <li>{usageLine(usage.automations, plan.max_automations, 'automations')}</li>
            </ul>
          </div>
          {data.canManage && isPaidAndRunning && !subscription.cancel_at_period_end ? (
            <Button variant="outline" size="sm" onClick={() => setCancelOpen(true)}>
              {t('cancel')}
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div
          role="radiogroup"
          aria-label={t('cycleLabel')}
          className="inline-flex rounded-lg border border-border p-0.5"
        >
          {(['monthly', 'yearly'] as const).map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={cycle === c}
              onClick={() => setCycle(c)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                cycle === c
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t(c)}
              {c === 'yearly' ? (
                <span className="ml-1.5 text-xs opacity-80">{t('yearlySave')}</span>
              ) : null}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t('gstNote')}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {data.plans.map((p) => {
          const isCurrent =
            p.id === subscription.plan_id &&
            subscription.billing_cycle === cycle &&
            isPaidAndRunning;
          const price = cycle === 'monthly' ? p.price_monthly_paise : p.price_yearly_paise;
          const canBuy =
            data.canManage && data.checkoutEnabled && p.purchasable[cycle] && !suspended;
          const features: { label: string; included: boolean }[] = [
            {
              label:
                p.max_members === null
                  ? t('features.membersUnlimited')
                  : t('features.members', { count: p.max_members }),
              included: true,
            },
            {
              label:
                p.max_automations === null
                  ? t('features.automationsUnlimited')
                  : t('features.automations', { count: p.max_automations }),
              included: true,
            },
            { label: t('features.ai'), included: p.feature_ai },
            { label: t('features.flows'), included: p.feature_flows },
            { label: t('features.api'), included: p.feature_api },
          ];

          return (
            <Card
              key={p.id}
              className={cn(isCurrent && 'ring-2 ring-primary')}
            >
              <CardContent className="flex h-full flex-col p-5">
                <div className="text-base font-semibold text-foreground">{p.name}</div>
                {p.description ? (
                  <p className="mt-1 text-sm text-muted-foreground">{p.description}</p>
                ) : null}
                <div className="mt-4 flex items-baseline gap-1">
                  <span className="text-2xl font-bold text-foreground">{formatInr(price)}</span>
                  <span className="text-sm text-muted-foreground">
                    {cycle === 'monthly' ? t('perMonth') : t('perYear')}
                  </span>
                </div>
                <ul className="mt-4 flex-1 space-y-2 text-sm">
                  {features.map((f) => (
                    <li
                      key={f.label}
                      className={cn(
                        'flex items-start gap-2',
                        f.included ? 'text-foreground' : 'text-muted-foreground line-through',
                      )}
                    >
                      {f.included ? (
                        <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                      ) : (
                        <Minus className="mt-0.5 size-4 shrink-0" />
                      )}
                      {f.label}
                    </li>
                  ))}
                </ul>
                <Button
                  className="mt-5 w-full"
                  variant={isCurrent ? 'outline' : 'default'}
                  disabled={isCurrent || !canBuy || pendingPlan !== null}
                  onClick={() => void choosePlan(p.id)}
                >
                  {pendingPlan === p.id ? <Loader2 className="size-4 animate-spin" /> : null}
                  {isCurrent
                    ? t('current')
                    : !p.purchasable[cycle]
                      ? t('notAvailable')
                      : isPaidAndRunning
                        ? t('switch')
                        : t('choose')}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {!data.canManage ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('adminOnly')}</p>
      ) : !data.checkoutEnabled ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('checkoutDisabled')}</p>
      ) : null}

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('cancelTitle')}</DialogTitle>
            <DialogDescription>
              {t('cancelBody', { date: fmtDate(subscription.current_period_end) })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelOpen(false)} disabled={cancelling}>
              {t('keep')}
            </Button>
            <Button variant="destructive" onClick={() => void cancelPlan()} disabled={cancelling}>
              {cancelling ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('cancelConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
