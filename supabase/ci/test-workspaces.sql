-- Behaviour test for multi-workspace membership (migration 046), run by
-- `.github/workflows/migrations.yml` after every migration is applied.
--
-- It signs up two users through the real signup trigger, then calls the
-- RPCs as each of them (by setting the JWT claims auth.uid() reads) and
-- asserts the outcome. Any RAISE fails the job.
--
-- Like verify-schema.sql this must be EXACTLY ONE statement: the CLI
-- sends the file as a single prepared statement.
DO $$
DECLARE
  agency UUID := gen_random_uuid();
  invitee UUID := gen_random_uuid();
  agency_home UUID;
  invitee_home UUID;
  client UUID;
  joined UUID;
  invitee_fallback UUID;
  n INTEGER;
BEGIN
  -- ---- signup: one workspace each, mirrored into memberships ----
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES
    (agency, 'agency@ci.test', '{"full_name": "Agency"}'),
    (invitee, 'invitee@ci.test', '{"full_name": "Invitee"}');

  SELECT account_id INTO agency_home FROM profiles WHERE user_id = agency;
  SELECT account_id INTO invitee_home FROM profiles WHERE user_id = invitee;
  IF agency_home IS NULL OR invitee_home IS NULL THEN
    RAISE EXCEPTION 'signup did not create workspaces';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM account_memberships
    WHERE user_id = agency AND account_id = agency_home AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'signup workspace was not mirrored into account_memberships';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM account_subscriptions
    WHERE account_id = agency_home AND status = 'trialing' AND trial_ends_at > NOW()
  ) THEN
    RAISE EXCEPTION 'first workspace should start a trial';
  END IF;

  -- ---- as the agency: create a client workspace, switch back ----
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', agency, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', agency::text, true);

  client := public.create_workspace('Client One');
  IF (SELECT account_id FROM profiles WHERE user_id = agency) <> client THEN
    RAISE EXCEPTION 'create_workspace did not switch into the new workspace';
  END IF;
  IF EXISTS (
    SELECT 1 FROM account_subscriptions
    WHERE account_id = client AND trial_ends_at > NOW()
  ) THEN
    RAISE EXCEPTION 'a second workspace must not get a free trial';
  END IF;
  SELECT count(*) INTO n FROM account_memberships WHERE user_id = agency;
  IF n <> 2 THEN
    RAISE EXCEPTION 'agency should belong to 2 workspaces, has %', n;
  END IF;

  PERFORM public.switch_account(agency_home);
  IF (SELECT account_id FROM profiles WHERE user_id = agency) <> agency_home THEN
    RAISE EXCEPTION 'switch_account did not switch';
  END IF;

  -- ---- invite: the invitee joins the client workspace ----
  INSERT INTO account_invitations (account_id, token_hash, role, expires_at)
  VALUES (client, 'ci-token-hash', 'agent', NOW() + INTERVAL '1 day');

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', invitee, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', invitee::text, true);

  joined := public.redeem_invitation('ci-token-hash');
  IF joined <> client
     OR (SELECT account_id FROM profiles WHERE user_id = invitee) <> client
     OR (SELECT account_role FROM profiles WHERE user_id = invitee) <> 'agent' THEN
    RAISE EXCEPTION 'redeem_invitation did not switch the invitee into the client as agent';
  END IF;
  IF EXISTS (SELECT 1 FROM accounts WHERE id = invitee_home) THEN
    RAISE EXCEPTION 'the invitee''s empty signup workspace should have been tidied up';
  END IF;

  -- The invitee can't switch into a workspace they don't belong to.
  BEGIN
    PERFORM public.switch_account(agency_home);
    RAISE EXCEPTION 'switch_account let a non-member in';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- ---- as the agency, managing the client workspace from elsewhere ----
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', agency, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', agency::text, true);
  PERFORM public.switch_account(client);

  PERFORM public.set_member_role(invitee, 'admin');
  IF (SELECT role FROM account_memberships WHERE user_id = invitee AND account_id = client) <> 'admin'
     OR (SELECT account_role FROM profiles WHERE user_id = invitee) <> 'admin' THEN
    RAISE EXCEPTION 'set_member_role did not update membership and active role';
  END IF;

  invitee_fallback := public.remove_account_member(invitee);
  IF EXISTS (
    SELECT 1 FROM account_memberships WHERE user_id = invitee AND account_id = client
  ) THEN
    RAISE EXCEPTION 'remove_account_member left the membership behind';
  END IF;
  IF (SELECT account_id FROM profiles WHERE user_id = invitee) <> invitee_fallback
     OR invitee_fallback = client THEN
    RAISE EXCEPTION 'removed member was not moved to a workspace of their own';
  END IF;
  IF EXISTS (
    SELECT 1 FROM account_subscriptions
    WHERE account_id = invitee_fallback AND trial_ends_at > NOW()
  ) THEN
    RAISE EXCEPTION 'a fallback workspace must not get a fresh trial';
  END IF;

  -- The owner can't leave their own workspace.
  BEGIN
    PERFORM public.leave_account(client);
    RAISE EXCEPTION 'leave_account let the owner leave';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;

  RAISE NOTICE 'workspace membership tests passed';
END
$$;
