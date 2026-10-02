// ============================================================
// Workspace switching (migration 046). Shared by the
// /api/account/workspaces routes.
// ============================================================

import { NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";

/** Map the RPCs' SQLSTATEs (see migration 046) onto HTTP statuses. */
export function workspaceRpcError(err: PostgrestError, fallback: string): NextResponse {
  if (err.code === "42501") {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err.code === "22023") {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  console.error("[workspaces] unexpected RPC error:", err);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read `{ account_id }` from a request body, or null if absent/invalid. */
export async function readAccountId(request: Request): Promise<string | null> {
  const body = (await request.json().catch(() => null)) as { account_id?: unknown } | null;
  const id = body?.account_id;
  return typeof id === "string" && UUID_RE.test(id) ? id : null;
}
