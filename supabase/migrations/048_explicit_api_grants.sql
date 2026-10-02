-- ============================================================
-- 048_explicit_api_grants.sql — Grant the API roles table access
--
-- The migrations never GRANT table privileges: they relied on
-- Supabase's long-standing default privileges, under which every table
-- created in `public` was automatically readable/writable by `anon`,
-- `authenticated` and `service_role`, with row-level security deciding
-- which rows. Newer Supabase stacks (seen with CLI 2.113's local stack)
-- no longer grant that automatically: `authenticated` and
-- `service_role` were left with only REFERENCES/TRIGGER/TRUNCATE on all
-- 41 tables, so signing in failed with "permission denied for table
-- profiles" and every server-side query failed too.
--
-- This grants the API roles explicitly, and sets default privileges so
-- tables added by later migrations get the same. RLS is unchanged and
-- still decides every row: tables meant to be server-only
-- (billing_events, admin_audit_log, …) have RLS on and no policies, so
-- `authenticated` still can't read or write a single row of them.
--
-- `anon` is deliberately NOT granted table access: signed-out requests
-- only use the auth API and the explicitly granted RPCs
-- (peek_invitation).
--
-- Idempotent — safe to re-run, and a no-op on projects that still have
-- the old defaults.
-- ============================================================

GRANT USAGE ON SCHEMA public TO authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role;
