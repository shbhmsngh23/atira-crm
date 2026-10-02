'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CreditCard, TriangleAlert } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { buttonVariants } from '@/components/ui/button';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import type { SubscriptionStatus } from '@/lib/billing/plans';

/** Start nagging this many days before the trial ends. */
const TRIAL_WARNING_DAYS = 3;

interface BillingSummary {
  usable: boolean;
  trialDaysLeft: number | null;
  hadTrial: boolean;
  subscription: { status: SubscriptionStatus; suspended_at: string | null };
}

/**
 * Above every dashboard page: the trial is about to end, a payment
 * failed, or the workspace is paused because the plan lapsed. Renders
 * nothing when the plan is healthy, and nothing on the Billing panel
 * itself (it already says all of this).
 */
export function BillingBanner() {
  const { accountStatus } = useAuth();
  const pathname = usePathname();
  const t = useTranslations('BillingBanner');
  const [summary, setSummary] = useState<BillingSummary | null>(null);

  useEffect(() => {
    if (accountStatus !== 'ready') return;
    let cancelled = false;
    fetch('/api/billing', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: BillingSummary | null) => {
        if (!cancelled && data) setSummary(data);
      })
      .catch(() => {
        // Non-essential: the Billing panel and the API's 402s still
        // explain the state if this request fails.
      });
    return () => {
      cancelled = true;
    };
  }, [accountStatus]);

  if (!summary || pathname.startsWith('/settings')) return null;

  const { usable, trialDaysLeft, subscription } = summary;
  const trialEnding =
    usable &&
    subscription.status === 'trialing' &&
    trialDaysLeft !== null &&
    trialDaysLeft <= TRIAL_WARNING_DAYS;
  const pastDue = usable && subscription.status === 'past_due';

  if (usable && !trialEnding && !pastDue) return null;

  let title: string;
  let body: string;
  if (subscription.suspended_at) {
    title = t('suspendedTitle');
    body = t('suspendedBody');
  } else if (!usable && subscription.status === 'trialing' && !summary.hadTrial) {
    title = t('noPlanTitle');
    body = t('noPlanBody');
  } else if (!usable) {
    title =
      subscription.status === 'trialing'
        ? t('trialEndedTitle')
        : t('inactiveTitle');
    body = t('inactiveBody');
  } else if (pastDue) {
    title = t('pastDueTitle');
    body = t('pastDueBody');
  } else {
    title = t('trialEnding', { days: trialDaysLeft ?? 0 });
    body = t('trialEndingBody');
  }

  return (
    <Alert variant={usable ? 'default' : 'destructive'} className="mb-4">
      {usable ? <CreditCard /> : <TriangleAlert />}
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{body}</AlertDescription>
      {subscription.suspended_at ? null : (
        <AlertAction>
          <Link
            href="/settings?tab=billing"
            className={buttonVariants({
              size: 'sm',
              variant: usable ? 'outline' : 'default',
            })}
          >
            {t('choosePlan')}
          </Link>
        </AlertAction>
      )}
    </Alert>
  );
}
