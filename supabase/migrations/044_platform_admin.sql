-- ============================================================
-- 044_platform_admin.sql — Platform admin: suspension + audit log
--
-- Supports the /admin console used by the people who run the Atira CRM
-- service (not workspace admins). Who counts as a platform admin is
-- configured outside the database, in PLATFORM_ADMIN_EMAILS, so no
-- database write can grant it.
--
-- What this migration does
--   1. `account_subscriptions.suspended_at` / `suspended_reason` — a
--      suspended workspace is paused exactly like a lapsed one, whatever
--      its plan. Kept apart from `status` so the Razorpay webhook (which
--      rewrites `status`) can never lift a suspension.
--   2. `admin_audit_log` — one row per platform-admin action (extend
--      trial, change plan, suspend, unsuspend). Service role only.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE account_subscriptions
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_reason TEXT;

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_email TEXT NOT NULL,
  account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_account
  ON admin_audit_log(account_id, created_at DESC);

-- Service role only: RLS on with no policies.
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
