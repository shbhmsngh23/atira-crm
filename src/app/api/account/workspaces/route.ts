// ============================================================
// /api/account/workspaces
//
//   GET  — every workspace the caller belongs to, with their role in
//          each and which one is active. Drives the switcher.
//   POST — { name } create a workspace owned by the caller and switch
//          into it. It starts without a free trial (only a user's
//          first workspace gets one; see migration 046).
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { workspaceRpcError } from "@/lib/account/workspaces";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { data: memberships, error } = await ctx.supabase
      .from("account_memberships")
      .select("account_id, role")
      .eq("user_id", ctx.userId);
    if (error) {
      console.error("[workspaces] membership load failed:", error);
      return NextResponse.json({ error: "Failed to load workspaces" }, { status: 500 });
    }

    const ids = (memberships ?? []).map((m) => m.account_id as string);
    const { data: accounts, error: accountsErr } = ids.length
      ? await ctx.supabase.from("accounts").select("id, name").in("id", ids)
      : { data: [], error: null };
    if (accountsErr) {
      console.error("[workspaces] account load failed:", accountsErr);
      return NextResponse.json({ error: "Failed to load workspaces" }, { status: 500 });
    }
    const nameById = new Map((accounts ?? []).map((a) => [a.id as string, a.name as string]));

    const workspaces = (memberships ?? [])
      .map((m) => ({
        id: m.account_id as string,
        name: nameById.get(m.account_id as string) ?? "Workspace",
        role: m.role as string,
        active: m.account_id === ctx.accountId,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ workspaces });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();

    const limit = await checkRateLimit(`workspace:create:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 80) {
      return NextResponse.json(
        { error: "Workspace name must be 1 to 80 characters" },
        { status: 400 },
      );
    }

    const { data, error } = await ctx.supabase.rpc("create_workspace", { p_name: name });
    if (error) return workspaceRpcError(error, "Failed to create workspace");
    return NextResponse.json({ id: data as string }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
