// POST /api/account/workspaces/leave — { account_id }
// Leave a workspace you don't own. If it was the active one, another
// of your workspaces becomes active (or a new personal one is made).

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { readAccountId, workspaceRpcError } from "@/lib/account/workspaces";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();

    const limit = await checkRateLimit(`workspace:leave:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const accountId = await readAccountId(request);
    if (!accountId) {
      return NextResponse.json({ error: "'account_id' is required" }, { status: 400 });
    }

    const { data, error } = await ctx.supabase.rpc("leave_account", { p_account_id: accountId });
    if (error) return workspaceRpcError(error, "Failed to leave workspace");
    return NextResponse.json({ activeAccountId: data as string });
  } catch (err) {
    return toErrorResponse(err);
  }
}
