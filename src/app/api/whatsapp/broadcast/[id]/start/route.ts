// ============================================================
// POST /api/whatsapp/broadcast/[id]/start
//
// Hands a broadcast the wizard just created (status 'sending',
// recipients 'pending') to the server-side worker and returns 202
// straight away. The browser tab can close: what this run doesn't
// finish, GET /api/broadcasts/cron continues.
// ============================================================

import { NextResponse, after } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { requireUsableSubscription } from '@/lib/billing/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { runBroadcastDelivery } from '@/lib/whatsapp/broadcast-queue';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const maxDuration = 300;

/** Stop starting new sends this long before the function's limit. */
const RUN_BUDGET_MS = (maxDuration - 30) * 1000;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    await requireUsableSubscription({ supabase, accountId });

    const limit = checkRateLimit(`broadcast-start:${userId}`, RATE_LIMITS.broadcast);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;

    // Account-scoped read through the caller's client (RLS) before the
    // service-role worker touches it.
    const { data: broadcast } = await supabase
      .from('broadcasts')
      .select('id, status')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!broadcast) {
      return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 });
    }
    if (broadcast.status !== 'sending') {
      return NextResponse.json(
        { error: `Only a broadcast that is sending can be started (this one is '${broadcast.status}')` },
        { status: 409 }
      );
    }

    const deadline = Date.now() + RUN_BUDGET_MS;
    after(async () => {
      try {
        await runBroadcastDelivery(supabaseAdmin(), id, deadline);
      } catch (err) {
        console.error('[broadcast-start] run failed:', err);
      }
    });

    return NextResponse.json({ success: true, broadcast_id: id }, { status: 202 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
