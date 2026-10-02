// ============================================================
// Platform admins — the people who run the Atira CRM service, as
// opposed to a workspace's own owner/admin roles.
//
// Configured only through the PLATFORM_ADMIN_EMAILS environment
// variable (comma-separated). Nothing in the database can grant it, so
// a SQL injection or a bad RLS policy can't create a platform admin.
// The email must also be confirmed, so signing up with an admin's
// address without access to that inbox gets you nothing.
//
// Server only.
// ============================================================

import type { User } from '@supabase/supabase-js';

import { ForbiddenError, UnauthorizedError } from '@/lib/auth/account';
import { createClient } from '@/lib/supabase/server';

export function platformAdminEmails(
  raw: string | undefined = process.env.PLATFORM_ADMIN_EMAILS
): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0)
  );
}

export function isPlatformAdminUser(
  user: Pick<User, 'email' | 'email_confirmed_at'> | null,
  allowed: Set<string> = platformAdminEmails()
): boolean {
  if (!user?.email || !user.email_confirmed_at) return false;
  return allowed.has(user.email.trim().toLowerCase());
}

export interface PlatformAdminContext {
  userId: string;
  email: string;
}

export async function requirePlatformAdmin(): Promise<PlatformAdminContext> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) throw new UnauthorizedError();
  if (!isPlatformAdminUser(user))
    throw new ForbiddenError('Not a platform admin');
  return { userId: user.id, email: user.email! };
}
