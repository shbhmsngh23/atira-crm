-- ============================================================
-- 043_billing.sql — Plans, subscriptions and Razorpay billing
--
-- Turns the multi-tenant install into a paid SaaS. Every account gets
-- exactly one `account_subscriptions` row that says which plan it is
-- on and whether that plan is currently usable. The app reads it to
-- gate sends, AI, the public API, flows, seat count and automation
-- count (src/lib/billing/*).
--
-- What this migration does
--   1. `plans` — the catalogue. Prices are stored in paise (INR). The
--      matching Razorpay plan ids are filled in per environment after
--      creating the plans in the Razorpay dashboard (docs/billing.md).
--      Any limit left NULL means "unlimited".
--   2. `account_subscriptions` — one row per account. Written ONLY by
--      the service role (signup trigger + Razorpay webhook + billing
--      routes); members may read their own account's row.
--   3. `billing_events` — raw Razorpay webhook log, unique on the
--      Razorpay event id so a redelivered webhook is applied once.
--   4. A trigger on `accounts` that starts a 14-day trial for every new
--      account, plus a backfill so existing accounts get one too.
--
-- WhatsApp conversation charges are NOT billed here: customers pay
-- Meta directly on their own WhatsApp Business Account.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- PLANS
-- ============================================================
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  price_monthly_paise INTEGER NOT NULL DEFAULT 0 CHECK (price_monthly_paise >= 0),
  price_yearly_paise INTEGER NOT NULL DEFAULT 0 CHECK (price_yearly_paise >= 0),
  razorpay_plan_id_monthly TEXT UNIQUE,
  razorpay_plan_id_yearly TEXT UNIQUE,
  max_members INTEGER CHECK (max_members IS NULL OR max_members > 0),
  max_automations INTEGER CHECK (max_automations IS NULL OR max_automations >= 0),
  feature_ai BOOLEAN NOT NULL DEFAULT FALSE,
  feature_api BOOLEAN NOT NULL DEFAULT FALSE,
  feature_flows BOOLEAN NOT NULL DEFAULT FALSE,
  -- FALSE hides the plan from the pricing table (e.g. 'trial', or a
  -- custom plan negotiated with one agency).
  is_public BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plans_select ON plans;
CREATE POLICY plans_select ON plans
  FOR SELECT TO authenticated
  USING (TRUE);

DROP TRIGGER IF EXISTS set_updated_at ON plans;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Starting catalogue. ON CONFLICT DO NOTHING so prices or limits edited
-- later in the database are never reset by a re-run.
INSERT INTO plans (
  id, name, description,
  price_monthly_paise, price_yearly_paise,
  max_members, max_automations,
  feature_ai, feature_api, feature_flows,
  is_public, sort_order
) VALUES
  ('trial',   'Free trial', '14 days of Growth features.',
     0,        0,          3,    10,   TRUE,  TRUE,  TRUE,  FALSE, 0),
  ('starter', 'Starter',    'Shared inbox, broadcasts and basic automations for small teams.',
     199900,   1999000,    3,    5,    FALSE, FALSE, FALSE, TRUE,  1),
  ('growth',  'Growth',     'AI replies, chatbot flows and the API for growing teams.',
     499900,   4999000,    10,   25,   TRUE,  TRUE,  TRUE,  TRUE,  2),
  ('pro',     'Pro',        'Unlimited seats and automations for large teams and agencies.',
     999900,   9999000,    NULL, NULL, TRUE,  TRUE,  TRUE,  TRUE,  3)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- ACCOUNT SUBSCRIPTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS account_subscriptions (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL
    CHECK (status IN ('trialing', 'active', 'past_due', 'halted', 'cancelled')),
  billing_cycle TEXT CHECK (billing_cycle IN ('monthly', 'yearly')),
  trial_ends_at TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  razorpay_subscription_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_subscriptions_plan
  ON account_subscriptions(plan_id);

ALTER TABLE account_subscriptions ENABLE ROW LEVEL SECURITY;

-- Read-only for members. There are deliberately no INSERT / UPDATE /
-- DELETE policies: a member must never be able to grant themselves a
-- plan. All writes go through the service role.
DROP POLICY IF EXISTS account_subscriptions_select ON account_subscriptions;
CREATE POLICY account_subscriptions_select ON account_subscriptions
  FOR SELECT TO authenticated
  USING (is_account_member(account_id, 'viewer'));

DROP TRIGGER IF EXISTS set_updated_at ON account_subscriptions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON account_subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- BILLING EVENTS (Razorpay webhook log)
-- ============================================================
CREATE TABLE IF NOT EXISTS billing_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  razorpay_event_id TEXT NOT NULL UNIQUE,
  event TEXT NOT NULL,
  account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_events_account
  ON billing_events(account_id, created_at DESC);

-- Service role only: RLS on with no policies.
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- TRIAL ON ACCOUNT CREATION
-- ============================================================
CREATE OR REPLACE FUNCTION public.start_account_trial()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.account_subscriptions (account_id, plan_id, status, trial_ends_at)
  VALUES (NEW.id, 'trial', 'trialing', NOW() + INTERVAL '14 days')
  ON CONFLICT (account_id) DO NOTHING;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.start_account_trial() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_account_created_start_trial ON accounts;
CREATE TRIGGER on_account_created_start_trial
  AFTER INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION public.start_account_trial();

-- Existing accounts start a fresh 14-day trial from the day billing
-- ships, rather than being locked out immediately.
INSERT INTO account_subscriptions (account_id, plan_id, status, trial_ends_at)
SELECT id, 'trial', 'trialing', NOW() + INTERVAL '14 days'
FROM accounts
ON CONFLICT (account_id) DO NOTHING;
