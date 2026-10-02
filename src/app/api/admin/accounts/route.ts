// GET /api/admin/accounts?q=&state=&page= — every workspace, newest
// first, searchable by workspace name, any member's email, or account
// id. Platform admins only.

import { NextResponse, type NextRequest } from 'next/server';

import { requirePlatformAdmin } from '@/lib/admin/auth';
import {
  PAGE_SIZE,
  listAccounts,
  loadPlans,
  sanitizeSearch,
} from '@/lib/admin/accounts';
import { ACCOUNT_STATES, type AccountState } from '@/lib/admin/state';
import { toErrorResponse } from '@/lib/auth/account';

export async function GET(request: NextRequest) {
  try {
    await requirePlatformAdmin();

    const params = request.nextUrl.searchParams;
    const rawState = params.get('state');
    const state = (ACCOUNT_STATES as readonly string[]).includes(rawState ?? '')
      ? (rawState as AccountState)
      : null;
    const page = Math.max(
      1,
      Math.min(10_000, Number.parseInt(params.get('page') ?? '1', 10) || 1)
    );

    const [{ accounts, total }, plans] = await Promise.all([
      listAccounts({ q: sanitizeSearch(params.get('q')), state, page }),
      loadPlans(),
    ]);

    return NextResponse.json({
      accounts,
      total,
      page,
      pageSize: PAGE_SIZE,
      plans: plans.map((p) => ({ id: p.id, name: p.name })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
