// GET /api/admin/me — whether the signed-in user is a platform admin.
// Drives the Admin link in the sidebar; the /api/admin/* routes check
// again on every call.

import { NextResponse } from 'next/server';

import { isPlatformAdminUser } from '@/lib/admin/auth';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return NextResponse.json({ isPlatformAdmin: isPlatformAdminUser(user) });
}
