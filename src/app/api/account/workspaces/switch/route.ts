// POST /api/account/workspaces/switch — { account_id }
// Make one of the caller's workspaces the active one. The client
// reloads afterwards: every query, subscription and cached profile in
// the tab belongs to the previous workspace.

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { readAccountId, workspaceRpcError } from "@/lib/account/workspaces";

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const accountId = await readAccountId(request);
    if (!accountId) {
      return NextResponse.json({ error: "'account_id' is required" }, { status: 400 });
    }
    if (accountId === ctx.accountId) return NextResponse.json({ ok: true });

    const { error } = await ctx.supabase.rpc("switch_account", { p_account_id: accountId });
    if (error) return workspaceRpcError(error, "Failed to switch workspace");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
