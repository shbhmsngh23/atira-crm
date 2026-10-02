// GET /api/admin/stats — numbers for the /admin dashboard.
// Platform admins only.

import { NextResponse } from 'next/server';

import { requirePlatformAdmin } from '@/lib/admin/auth';
import { loadAllSubscriptions, loadPlans } from '@/lib/admin/accounts';
import { computeStats } from '@/lib/admin/state';
import { toErrorResponse } from '@/lib/auth/account';

export async function GET() {
  try {
    await requirePlatformAdmin();
    const [subscriptions, plans] = await Promise.all([
      loadAllSubscriptions(),
      loadPlans(),
    ]);
    return NextResponse.json({ stats: computeStats(subscriptions, plans) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
