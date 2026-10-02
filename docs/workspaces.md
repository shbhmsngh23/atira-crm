# Workspaces and agencies

A **workspace** (called an account in the code and database) is one
business on Atira CRM: its own WhatsApp number, contacts, inbox, team,
automations and plan. One login can belong to several workspaces, which
is how an agency runs WhatsApp for its clients.

## For users

- The workspace menu sits at the bottom of the sidebar, above your name.
  It shows the workspace you're in and your role there, lists every
  workspace you belong to, and switches between them. Switching reloads
  the app so nothing from the previous workspace stays on screen.
- **Create workspace** makes a new workspace that you own and switches
  you into it. Connect its WhatsApp number and invite the client's team
  from its Settings, as for any workspace.
- **Accepting an invitation** adds that workspace to your list and
  switches you into it. You keep the workspaces you already had. (An
  untouched empty workspace from signup is tidied up.)
- **Leave this workspace** is available to everyone except the owner.
  The owner transfers ownership first (Settings → Team members).
- Each person's role is per workspace: you can own your agency's
  workspace and be an agent in a client's.

## Billing

Each workspace has its own plan. Only a user's first workspace gets the
14-day free trial; workspaces created from the menu start without one,
so the creator chooses a plan in that workspace's Settings → Billing &
plan. For an agency deal, a platform admin can grant a plan by hand on
each client workspace from `/admin` (see docs/billing.md).

## How it works

- `account_memberships` (migration 046) lists every workspace a user
  belongs to and their role in each.
- `profiles.account_id` / `account_role` are the user's **active**
  workspace. Every row-level security policy checks only the active
  workspace, so a session can never read across workspaces at once.
- Switching, creating, leaving, inviting and the Members actions are
  `SECURITY DEFINER` functions that check the caller's membership first.
- `supabase/ci/test-workspaces.sql` exercises these flows on every
  migration change in CI.
