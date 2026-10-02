// ============================================================
// GET /api/broadcasts/cron — scheduled broadcast worker.
//
// Starts scheduled broadcasts that are due and continues broadcasts
// still sending (large campaigns, or ones Meta throttled). Call it
// every minute from your scheduler with the `x-cron-secret` header set
// to AUTOMATION_CRON_SECRET, like /api/automations/cron.
// ============================================================

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { runBroadcastQueue } from '@/lib/whatsapp/broadcast-queue';

export const maxDuration = 300;

/** Stop starting new sends this long before the function's limit. */
const RUN_BUDGET_MS = (maxDuration - 30) * 1000;

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '');
  const expectedBuf = Buffer.from(expected);
  if (supplied.length !== expectedBuf.length || !timingSafeEqual(supplied, expectedBuf)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const summary = await runBroadcastQueue(supabaseAdmin(), Date.now() + RUN_BUDGET_MS);
    return NextResponse.json(summary);
  } catch (err) {
    console.error('[broadcast-cron] failed:', err);
    return NextResponse.json({ error: 'Broadcast worker failed' }, { status: 500 });
  }
}
