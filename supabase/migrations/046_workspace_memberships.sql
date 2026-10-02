-- ============================================================
-- 046_workspace_memberships.sql — One login, several workspaces
--
-- Until now a user belonged to exactly one account (workspace):
-- `profiles.account_id` / `account_role`. Agencies run WhatsApp for
-- several clients and need one login that can move between them.
--
-- Design: memberships + an active workspace
--
--   `account_memberships` lists every workspace a user belongs to and
--   their role in each. `profiles.account_id` / `account_role` stay as
--   the user's ACTIVE workspace, so `is_account_member()` and every RLS
--   policy built on it are unchanged: a session only ever sees the one
--   workspace it is switched into. Switching is a supervised RPC.
--
--   A trigger keeps the active workspace mirrored into
--   `account_memberships`, so every writer of profiles (signup, the
--   member RPCs below, service-role code) keeps memberships correct.
--
-- What this migration does
--   1. `account_memberships` + backfill from profiles + mirror trigger.
--   2. Lets one user own several accounts (drops the one-per-owner index).
--   3. `profiles_select` now shows every member of the active workspace,
--      including members currently switched into another workspace.
--   4. New RPCs: switch_account, create_workspace, leave_account.
--   5. Rewrites set_member_role, remove_account_member,
--      transfer_account_ownership and redeem_invitation (018/019) to
--      work on memberships instead of the single profile row.
--
-- Billing: a workspace created with create_workspace does NOT get a
-- free trial (only a user's first workspace does), otherwise anyone
-- could create endless 14-day trials. Agencies pay per client
-- workspace, or a platform admin grants a plan by hand.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. MEMBERSHIPS
-- ============================================================
CREATE TABLE IF NOT EXISTS account_memberships (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role account_role_enum NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_account_memberships_account
  ON account_memberships(account_id, role);

ALTER TABLE account_memberships ENABLE ROW LEVEL SECURITY;

-- A user sees their own memberships (the workspace switcher) and the
-- memberships of their active workspace (the Members list). Writes go
-- through the SECURITY DEFINER functions below only.
DROP POLICY IF EXISTS account_memberships_select ON account_memberships;
CREATE POLICY account_memberships_select ON account_memberships
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR is_account_member(account_id, 'viewer'));

-- Backfill from the single-membership model.
INSERT INTO account_memberships (user_id, account_id, role)
SELECT user_id, account_id, account_role
FROM profiles
WHERE account_id IS NOT NULL AND account_role IS NOT NULL
ON CONFLICT (user_id, account_id) DO NOTHING;

-- Mirror the active workspace into memberships.
CREATE OR REPLACE FUNCTION public.sync_active_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.account_id IS NOT NULL AND NEW.account_role IS NOT NULL THEN
    INSERT INTO account_memberships (user_id, account_id, role)
    VALUES (NEW.user_id, NEW.account_id, NEW.account_role)
    ON CONFLICT (user_id, account_id) DO UPDATE SET role = EXCLUDED.role;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.sync_active_membership() OWNER TO postgres;

DROP TRIGGER IF EXISTS sync_active_membership ON profiles;
CREATE TRIGGER sync_active_membership
  AFTER INSERT OR UPDATE OF account_id, account_role ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.sync_active_membership();

-- ============================================================
-- 2. SEVERAL OWNED ACCOUNTS PER USER
-- ============================================================
DROP INDEX IF EXISTS idx_accounts_one_per_owner;

-- The workspace switcher lists the names of every workspace the user
-- belongs to, not just the active one. Read-only; updates still need
-- admin in the ACTIVE workspace (017's accounts_update).
DROP POLICY IF EXISTS accounts_select ON accounts;
CREATE POLICY accounts_select ON accounts FOR SELECT
  USING (
    is_account_member(id)
    OR EXISTS (
      SELECT 1 FROM account_memberships m
      WHERE m.account_id = accounts.id AND m.user_id = auth.uid()
    )
  );

-- ============================================================
-- 3. PROFILE VISIBILITY
--
-- Was: profiles whose ACTIVE account is mine. A teammate switched into
-- another workspace vanished from assignee pickers. Now: profiles of
-- anyone who is a member of my active workspace.
-- ============================================================
DROP POLICY IF EXISTS profiles_select ON profiles;
CREATE POLICY profiles_select ON profiles FOR SELECT
  USING (
    auth.uid() = user_id
    OR EXISTS (
      SELECT 1 FROM account_memberships m
      WHERE m.user_id = profiles.user_id
        AND is_account_member(m.account_id, 'viewer')
    )
  );

-- ============================================================
-- 4. SWITCH / CREATE / LEAVE
-- ============================================================

-- Make one of the caller's workspaces the active one.
CREATE OR REPLACE FUNCTION public.switch_account(p_account_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT role INTO v_role
  FROM account_memberships
  WHERE user_id = auth.uid() AND account_id = p_account_id;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'You are not a member of that workspace' USING ERRCODE = '42501';
  END IF;

  UPDATE profiles
  SET account_id = p_account_id, account_role = v_role
  WHERE user_id = auth.uid();
END;
$$;

ALTER FUNCTION public.switch_account(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.switch_account(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.switch_account(UUID) TO authenticated;

-- Create a workspace owned by the caller and switch into it.
CREATE OR REPLACE FUNCTION public.create_workspace(p_name TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := btrim(COALESCE(p_name, ''));
  v_owned INTEGER;
  v_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  IF v_name = '' OR length(v_name) > 80 THEN
    RAISE EXCEPTION 'Workspace name must be 1 to 80 characters' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_owned FROM accounts WHERE owner_user_id = auth.uid();
  IF v_owned >= 100 THEN
    RAISE EXCEPTION 'You already own 100 workspaces. Contact support to raise the limit.'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO accounts (name, owner_user_id)
  VALUES (v_name, auth.uid())
  RETURNING id INTO v_account_id;

  -- The trial trigger (043) just started a 14-day trial. Only a user's
  -- first workspace gets one; end this one immediately.
  UPDATE account_subscriptions
  SET trial_ends_at = NOW()
  WHERE account_id = v_account_id AND status = 'trialing';

  INSERT INTO account_memberships (user_id, account_id, role)
  VALUES (auth.uid(), v_account_id, 'owner');

  UPDATE profiles
  SET account_id = v_account_id, account_role = 'owner'
  WHERE user_id = auth.uid();

  RETURN v_account_id;
END;
$$;

ALTER FUNCTION public.create_workspace(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_workspace(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_workspace(TEXT) TO authenticated;

-- Pick another workspace for a user whose active one they just lost.
-- Falls back to a fresh personal account (the pre-046 behaviour of
-- remove_account_member) when they have none left.
CREATE OR REPLACE FUNCTION public.reactivate_some_workspace(p_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_role account_role_enum;
  v_name TEXT;
  v_email TEXT;
BEGIN
  SELECT account_id, role INTO v_account_id, v_role
  FROM account_memberships
  WHERE user_id = p_user_id
  ORDER BY (role = 'owner') DESC, created_at ASC
  LIMIT 1;

  IF v_account_id IS NULL THEN
    SELECT full_name, email INTO v_name, v_email FROM profiles WHERE user_id = p_user_id;
    INSERT INTO accounts (name, owner_user_id)
    VALUES (COALESCE(NULLIF(v_name, ''), v_email, 'My account'), p_user_id)
    RETURNING id INTO v_account_id;
    v_role := 'owner';
    -- Not a new customer: no fresh free trial (see create_workspace).
    UPDATE account_subscriptions
    SET trial_ends_at = NOW()
    WHERE account_id = v_account_id AND status = 'trialing';
  END IF;

  UPDATE profiles
  SET account_id = v_account_id, account_role = v_role
  WHERE user_id = p_user_id;
  RETURN v_account_id;
END;
$$;

ALTER FUNCTION public.reactivate_some_workspace(UUID) OWNER TO postgres;
-- Internal helper: callable only from the definer functions here.
REVOKE ALL ON FUNCTION public.reactivate_some_workspace(UUID) FROM PUBLIC;

-- Leave a workspace you don't own.
CREATE OR REPLACE FUNCTION public.leave_account(p_account_id UUID)
RETURNS UUID  -- the workspace now active
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role account_role_enum;
  v_active UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT role INTO v_role
  FROM account_memberships
  WHERE user_id = auth.uid() AND account_id = p_account_id;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'You are not a member of that workspace' USING ERRCODE = '22023';
  END IF;
  IF v_role = 'owner' THEN
    RAISE EXCEPTION 'The owner cannot leave; transfer ownership first' USING ERRCODE = '22023';
  END IF;

  DELETE FROM account_memberships
  WHERE user_id = auth.uid() AND account_id = p_account_id;

  SELECT account_id INTO v_active FROM profiles WHERE user_id = auth.uid();
  IF v_active = p_account_id THEN
    RETURN public.reactivate_some_workspace(auth.uid());
  END IF;
  RETURN v_active;
END;
$$;

ALTER FUNCTION public.leave_account(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.leave_account(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.leave_account(UUID) TO authenticated;

-- ============================================================
-- 5. MEMBER RPCs, MEMBERSHIP-AWARE
--
-- Same signatures and error contract as 018/019. The caller still
-- acts on their ACTIVE workspace; the target is looked up by
-- membership rather than by the target's own active workspace.
-- ============================================================

CREATE OR REPLACE FUNCTION public.set_member_role(
  p_user_id UUID,
  p_new_role account_role_enum
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role INTO v_caller_account_id, v_caller_role
  FROM profiles WHERE user_id = auth.uid();
  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot change your own role' USING ERRCODE = '22023';
  END IF;

  SELECT role INTO v_target_role
  FROM account_memberships
  WHERE user_id = p_user_id AND account_id = v_caller_account_id;
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to demote an owner' USING ERRCODE = '22023';
  END IF;
  IF p_new_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to promote to owner' USING ERRCODE = '22023';
  END IF;

  UPDATE account_memberships SET role = p_new_role
  WHERE user_id = p_user_id AND account_id = v_caller_account_id;
  -- Keep the active-workspace copy in step if they're switched in.
  UPDATE profiles SET account_role = p_new_role
  WHERE user_id = p_user_id AND account_id = v_caller_account_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_account_member(
  p_user_id UUID
) RETURNS UUID  -- the removed user's now-active workspace
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_role account_role_enum;
  v_target_active UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role INTO v_caller_account_id, v_caller_role
  FROM profiles WHERE user_id = auth.uid();
  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot remove yourself; transfer ownership or leave the account instead'
      USING ERRCODE = '22023';
  END IF;

  SELECT role INTO v_target_role
  FROM account_memberships
  WHERE user_id = p_user_id AND account_id = v_caller_account_id;
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first'
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM account_memberships
  WHERE user_id = p_user_id AND account_id = v_caller_account_id;

  SELECT account_id INTO v_target_active FROM profiles WHERE user_id = p_user_id;
  IF v_target_active = v_caller_account_id THEN
    RETURN public.reactivate_some_workspace(p_user_id);
  END IF;
  RETURN v_target_active;
END;
$$;

CREATE OR REPLACE FUNCTION public.transfer_account_ownership(
  p_new_owner_user_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role INTO v_caller_account_id, v_caller_role
  FROM profiles WHERE user_id = auth.uid();
  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the account owner can transfer ownership' USING ERRCODE = '42501';
  END IF;
  IF p_new_owner_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You are already the owner' USING ERRCODE = '22023';
  END IF;

  SELECT role INTO v_target_role
  FROM account_memberships
  WHERE user_id = p_new_owner_user_id AND account_id = v_caller_account_id;
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;

  -- Demote first so the account never has two owners. One function,
  -- one transaction.
  UPDATE account_memberships SET role = 'admin'
  WHERE user_id = auth.uid() AND account_id = v_caller_account_id;
  UPDATE account_memberships SET role = 'owner'
  WHERE user_id = p_new_owner_user_id AND account_id = v_caller_account_id;
  UPDATE profiles SET account_role = 'admin'
  WHERE user_id = auth.uid() AND account_id = v_caller_account_id;
  UPDATE profiles SET account_role = 'owner'
  WHERE user_id = p_new_owner_user_id AND account_id = v_caller_account_id;
  UPDATE accounts SET owner_user_id = p_new_owner_user_id
  WHERE id = v_caller_account_id;
END;
$$;

-- Joining no longer means leaving: the caller keeps their existing
-- workspaces and is switched into the one they were invited to. The
-- one thing kept from 019 is tidying up the empty personal workspace a
-- brand-new user gets at signup, so invited teammates don't each end
-- up with a stray empty workspace (and trial) in their switcher.
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID  -- the joined account_id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_owner UUID;
  v_old_members INTEGER;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed' USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM account_memberships
    WHERE user_id = v_caller_id AND account_id = v_inv.account_id
  ) THEN
    RAISE EXCEPTION 'You are already a member of this account' USING ERRCODE = '23505';
  END IF;

  SELECT p.account_id, a.owner_user_id INTO v_old_account_id, v_old_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;
  IF v_old_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  INSERT INTO account_memberships (user_id, account_id, role)
  VALUES (v_caller_id, v_inv.account_id, v_inv.role);

  UPDATE profiles
  SET account_id = v_inv.account_id, account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(), accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  -- Tidy up an untouched signup workspace: owned by the caller, no
  -- other members, no data, never paid for.
  IF v_old_owner = v_caller_id THEN
    SELECT count(*) INTO v_old_members
    FROM account_memberships WHERE account_id = v_old_account_id;

    SELECT EXISTS (
      SELECT 1 FROM contacts WHERE account_id = v_old_account_id
      UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
      UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
      UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
      UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
      UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
      UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
      UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
      UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
      UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
      UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
      UNION ALL SELECT 1 FROM account_subscriptions
        WHERE account_id = v_old_account_id AND razorpay_subscription_id IS NOT NULL
      LIMIT 1
    ) INTO v_has_data;

    IF v_old_members = 1 AND NOT v_has_data THEN
      DELETE FROM accounts WHERE id = v_old_account_id;
    END IF;
  END IF;

  RETURN v_inv.account_id;
END;
$$;
