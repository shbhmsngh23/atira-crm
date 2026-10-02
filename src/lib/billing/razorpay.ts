// ============================================================
// Razorpay Subscriptions — minimal REST client.
//
// Plain `fetch` against https://api.razorpay.com/v1 with HTTP basic
// auth (key id : key secret), so there is no SDK dependency. Server
// only: the key secret must never reach the browser.
//
// Env:
//   RAZORPAY_KEY_ID          rzp_test_… / rzp_live_…
//   RAZORPAY_KEY_SECRET
//   RAZORPAY_WEBHOOK_SECRET  set on the webhook in the Razorpay dashboard
// ============================================================

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { BillingCycle, RazorpaySubscriptionEntity } from './plans';

const API_BASE = 'https://api.razorpay.com/v1';

/**
 * Number of billing cycles Razorpay should run before the subscription
 * completes. Razorpay requires a finite count; ten years is effectively
 * "until cancelled".
 */
export const TOTAL_COUNT: Record<BillingCycle, number> = {
  monthly: 120,
  yearly: 10,
};

export class RazorpayError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'RazorpayError';
    this.status = status;
  }
}

export function isRazorpayConfigured(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

async function razorpayRequest<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<T> {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new RazorpayError('Razorpay is not configured on this server', 503);
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });

  const payload = (await res.json().catch(() => null)) as
    | (T & { error?: { description?: string } })
    | null;

  if (!res.ok || !payload) {
    // Razorpay's error descriptions are written for the merchant
    // ("The plan id provided does not exist"), safe to show an admin.
    const description =
      payload?.error?.description ?? `Razorpay request failed (${res.status})`;
    throw new RazorpayError(description, res.status);
  }
  return payload;
}

export interface CreatedSubscription extends RazorpaySubscriptionEntity {
  /** Razorpay-hosted page where the customer authorises the payment. */
  short_url: string;
}

export function createSubscription(input: {
  razorpayPlanId: string;
  cycle: BillingCycle;
  accountId: string;
  planId: string;
}): Promise<CreatedSubscription> {
  return razorpayRequest<CreatedSubscription>('POST', '/subscriptions', {
    plan_id: input.razorpayPlanId,
    total_count: TOTAL_COUNT[input.cycle],
    customer_notify: 1,
    // Echoed back on every webhook — this is how an event finds its
    // account. Webhooks are signature-verified, so the notes can be
    // trusted there.
    notes: { account_id: input.accountId, plan_id: input.planId },
  });
}

/** Switch an existing subscription to another plan, effective now. */
export function changeSubscriptionPlan(
  subscriptionId: string,
  razorpayPlanId: string,
): Promise<RazorpaySubscriptionEntity> {
  return razorpayRequest<RazorpaySubscriptionEntity>(
    'PATCH',
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { plan_id: razorpayPlanId, schedule_change_at: 'now', customer_notify: 1 },
  );
}

/** Cancel at the end of the current billing period (no refund). */
export function cancelSubscriptionAtCycleEnd(
  subscriptionId: string,
): Promise<RazorpaySubscriptionEntity> {
  return razorpayRequest<RazorpaySubscriptionEntity>(
    'POST',
    `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
    { cancel_at_cycle_end: 1 },
  );
}

/**
 * Verify the `X-Razorpay-Signature` header: hex HMAC-SHA256 of the raw
 * request body keyed with the webhook secret. Constant-time compare.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const presented = signature.trim().toLowerCase();
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}
