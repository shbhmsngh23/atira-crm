# Billing — plans, trials and Razorpay

Atira CRM charges each workspace (account) a monthly or yearly
subscription in INR through **Razorpay Subscriptions**. WhatsApp
conversation charges are **not** billed here: each customer pays Meta
directly on their own WhatsApp Business Account.

## How it works

- Every new workspace starts a **14-day free trial** with Growth-level
  features (migration `043_billing.sql`). Existing workspaces got a fresh
  14-day trial when the migration ran.
- When the trial ends, or a paid plan lapses, the workspace is
  **paused**: sending messages and broadcasts, automations, chatbot flows,
  AI replies, the public API and outgoing webhooks stop. Incoming customer
  messages are still saved, and nothing is deleted.
- Admins and the owner pick a plan in **Settings → Billing & plan**. That
  opens Razorpay's hosted checkout. The plan changes in the app only when
  Razorpay's webhook confirms it.
- A failed renewal puts the workspace in **Payment due** while Razorpay
  retries the card; it keeps working. If Razorpay gives up, the plan is
  **halted** and the workspace pauses.
- Cancelling keeps the plan until the end of the period already paid for.

### What each plan limits

| | Trial | Starter | Growth | Pro |
|---|---|---|---|---|
| Price / month | free, 14 days | ₹1,999 | ₹4,999 | ₹9,999 |
| Price / year | — | ₹19,990 | ₹49,990 | ₹99,990 |
| Team members (incl. pending invites) | 3 | 3 | 10 | unlimited |
| Automations | 10 | 5 | 25 | unlimited |
| AI replies & knowledge base | ✓ | — | ✓ | ✓ |
| Chatbot flows | ✓ | — | ✓ | ✓ |
| REST API & webhooks | ✓ | — | ✓ | ✓ |

These are starting values. Change them in the `plans` table (prices are
in **paise**, a `NULL` limit means unlimited). To hide a plan from the
pricing page, set `is_public = false`. A workspace can be put on a hidden
plan, for example a custom agency deal, by updating its
`account_subscriptions` row.

Prices are shown excluding GST. Enable GST on your Razorpay invoices if
you are GST-registered.

## Setup

### 1. Create the plans in Razorpay

In Razorpay Dashboard → **Subscriptions → Plans**, create one plan per
paid plan and cycle (6 in total for Starter, Growth and Pro, monthly and
yearly). The amount in Razorpay **must equal** the price in the `plans`
table, because the app displays its own price but Razorpay charges its
own.

Then store each Razorpay plan id (`plan_…`) on the matching row:

```sql
UPDATE plans SET razorpay_plan_id_monthly = 'plan_XXXX', razorpay_plan_id_yearly = 'plan_YYYY' WHERE id = 'starter';
UPDATE plans SET razorpay_plan_id_monthly = 'plan_XXXX', razorpay_plan_id_yearly = 'plan_YYYY' WHERE id = 'growth';
UPDATE plans SET razorpay_plan_id_monthly = 'plan_XXXX', razorpay_plan_id_yearly = 'plan_YYYY' WHERE id = 'pro';
```

A plan and cycle without a Razorpay id shows as "Not available yet".

Test mode and live mode have different plan ids. Use the test ids in
your staging database and the live ids in production.

### 2. Environment variables

```
RAZORPAY_KEY_ID=rzp_live_…
RAZORPAY_KEY_SECRET=…
RAZORPAY_WEBHOOK_SECRET=…
```

Without the key pair the Billing page still shows the plans and trials
still run, but the checkout buttons are disabled.

### 3. Webhook

Razorpay Dashboard → **Settings → Webhooks → Add new webhook**:

- **URL:** `https://<your-domain>/api/billing/webhook`
- **Secret:** the same value as `RAZORPAY_WEBHOOK_SECRET`
- **Events:** `subscription.authenticated`, `subscription.activated`,
  `subscription.charged`, `subscription.pending`, `subscription.halted`,
  `subscription.paused`, `subscription.resumed`, `subscription.cancelled`,
  `subscription.completed`, `subscription.updated`

Every delivery is recorded in the `billing_events` table, which is the
first place to look when a payment doesn't show up in the app.

## Support tasks (SQL, until the admin panel exists)

Extend a trial:

```sql
UPDATE account_subscriptions
SET status = 'trialing', trial_ends_at = NOW() + INTERVAL '7 days'
WHERE account_id = '<account uuid>';
```

Find a workspace's subscription:

```sql
SELECT a.name, s.*
FROM account_subscriptions s JOIN accounts a ON a.id = s.account_id
WHERE a.name ILIKE '%acme%';
```

## Known limitations

- Changing plans uses Razorpay's in-place subscription update. Razorpay
  restricts which payment methods support updates (check its
  "Update a Subscription" docs for your account). When Razorpay refuses,
  the app shows Razorpay's error and the customer has to cancel and
  subscribe again after the period ends.
- A plan set to cancel at the end of the period can't be switched to
  another plan until it has ended.
- Moving to a plan with lower limits doesn't remove existing team members
  or automations; it only blocks adding new ones.
