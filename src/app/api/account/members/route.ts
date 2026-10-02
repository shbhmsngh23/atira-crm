// ============================================================
// GET /api/account/members
//
// Lists every member of the caller's account. Any member can call
// it (the Members tab is shown to admins+, but agents/viewers see
// a read-only roster too).
//
// Field visibility
//   Sensitive fields (email) are returned only when the caller is
//   admin+. Agents and viewers see name + avatar + role + joined
//   date only. This mirrors the design decision from the planning
//   phase: "agent/viewer sees names only".
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { canManageMembers, isAccountRole } from "@/lib/auth/roles";
import type { AccountMember } from "@/types";

interface MembershipRow {
  user_id: string;
  role: string;
  created_at: string;
}

interface ProfileRow {
  user_id: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    // Membership (migration 046), not each member's active workspace:
    // a teammate switched into another workspace is still a member here,
    // with the role they hold here. RLS scopes both reads to the
    // caller's active workspace.
    const { data: memberships, error } = await ctx.supabase
      .from("account_memberships")
      .select("user_id, role, created_at")
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[GET /api/account/members] fetch error:", error);
      return NextResponse.json(
        { error: "Failed to load members" },
        { status: 500 },
      );
    }

    const rows = (memberships ?? []) as MembershipRow[];
    const { data: profiles, error: profileErr } = rows.length
      ? await ctx.supabase
          .from("profiles")
          .select("user_id, full_name, email, avatar_url")
          .in(
            "user_id",
            rows.map((r) => r.user_id),
          )
      : { data: [], error: null };
    if (profileErr) {
      console.error("[GET /api/account/members] profile fetch error:", profileErr);
      return NextResponse.json(
        { error: "Failed to load members" },
        { status: 500 },
      );
    }
    const profileById = new Map(
      ((profiles ?? []) as ProfileRow[]).map((p) => [p.user_id, p]),
    );

    const canSeeEmails = canManageMembers(ctx.role);

    const members: AccountMember[] = rows.flatMap((row) => {
      // Defensive: the DB enum should never let an unknown role
      // through, but if a migration ever broadens the enum without
      // updating TS, skip the row rather than crash the page.
      if (!isAccountRole(row.role)) return [];
      const profile = profileById.get(row.user_id);
      return [
        {
          user_id: row.user_id,
          full_name: profile?.full_name ?? "",
          email: canSeeEmails ? (profile?.email ?? null) : null,
          avatar_url: profile?.avatar_url ?? null,
          role: row.role,
          joined_at: row.created_at,
        },
      ];
    });

    return NextResponse.json({ members });
  } catch (err) {
    return toErrorResponse(err);
  }
}
