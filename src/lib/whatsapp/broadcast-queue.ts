// ============================================================
// Server-side broadcast worker.
//
// A broadcast in status 'sending' has `pending` recipient rows; this
// module sends them. It is started two ways:
//
//   - right away, in `after()`, by the request that creates (or
//     resumes) a broadcast, so a small campaign finishes in seconds;
//   - by GET /api/broadcasts/cron on a schedule, which starts due
//     scheduled broadcasts and continues any whose first run hit its
//     time limit (large campaigns, or Meta asking us to slow down).
//
// Each run holds the broadcast's delivery lock (migration 038), works
// until its deadline, and leaves whatever is left `pending` for the
// next run. Nothing depends on a browser tab staying open.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { PaymentRequiredError } from '@/lib/auth/account';
import { loadBillingState } from '@/lib/billing/server';
import {
  finalizeBroadcastStatus,
  sendBroadcastRecipient,
  type BroadcastSendContext,
  type PlannedRecipient,
} from '@/lib/whatsapp/broadcast-core';
import {
  claimBroadcastDelivery,
  DELIVERY_LOCK_STALE_MS,
  releaseBroadcastDelivery,
} from '@/lib/whatsapp/broadcast-resume';
import { decrypt } from '@/lib/whatsapp/encryption';
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';

/**
 * Sends in flight at once for one broadcast. Meta's default throughput
 * is 80 messages/second per phone number; each send is a round trip of
 * a few hundred milliseconds, so 5 at a time stays far below it while
 * being ~5× faster than one by one.
 */
export const SEND_CONCURRENCY = 5;

/** Recipient rows loaded per round. */
const FETCH_SIZE = 100;

/**
 * The cron only continues broadcasts that made progress within this
 * window. Older 'sending' broadcasts (e.g. ones abandoned before the
 * worker existed) are left for a person to resume, so nobody gets a
 * campaign message days after it was meant to go out.
 */
export const AUTO_CONTINUE_WINDOW_MS = 60 * 60 * 1000;

export type RunStatus =
  | 'done' // nothing left pending
  | 'more' // stopped at the deadline with recipients left
  | 'throttled' // Meta asked us to slow down; the rest wait for the next run
  | 'locked' // another run holds the lock
  | 'not_sending' // not in 'sending' (draft, scheduled, finished, deleted)
  | 'plan_inactive'; // the workspace's plan is lapsed or suspended

export interface RunResult {
  status: RunStatus;
  sent: number;
  failed: number;
}

interface PendingRow {
  id: string;
  template_params: unknown;
  contact: { phone?: string | null } | { phone?: string | null }[] | null;
}

function rowPhone(row: PendingRow): string {
  const c = Array.isArray(row.contact) ? row.contact[0] : row.contact;
  return sanitizePhoneForMeta(c?.phone ?? '');
}

function rowParams(row: PendingRow): string[] {
  return Array.isArray(row.template_params)
    ? row.template_params.filter((p): p is string => typeof p === 'string')
    : [];
}

/** Run `worker` over `items`, `limit` at a time, until `stop()` says so. */
export async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  stop: () => boolean
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !stop()) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

async function failAllPending(db: SupabaseClient, broadcastId: string, message: string) {
  await db
    .from('broadcast_recipients')
    .update({ status: 'failed', error_message: message })
    .eq('broadcast_id', broadcastId)
    .eq('status', 'pending');
}

/** Whether the workspace's plan allows sending. Fails open on errors. */
async function planAllowsSending(db: SupabaseClient, accountId: string): Promise<boolean> {
  try {
    return (await loadBillingState(db, accountId)).usable;
  } catch (err) {
    if (err instanceof PaymentRequiredError) return false;
    console.error('[broadcast-queue] billing lookup failed, not gating:', err);
    return true;
  }
}

/**
 * Send one broadcast's pending recipients until `deadlineMs` (epoch ms).
 * Safe to call concurrently: only one caller gets the lock.
 */
export async function runBroadcastDelivery(
  db: SupabaseClient,
  broadcastId: string,
  deadlineMs: number
): Promise<RunResult> {
  const result: RunResult = { status: 'done', sent: 0, failed: 0 };

  const { data: broadcast } = await db
    .from('broadcasts')
    .select('id, account_id, status, template_name, template_language, header_media_url')
    .eq('id', broadcastId)
    .maybeSingle();
  if (!broadcast || broadcast.status !== 'sending') {
    return { ...result, status: 'not_sending' };
  }
  const accountId = broadcast.account_id as string;

  if (!(await planAllowsSending(db, accountId))) {
    return { ...result, status: 'plan_inactive' };
  }

  if (!(await claimBroadcastDelivery(db, accountId, broadcastId))) {
    return { ...result, status: 'locked' };
  }

  try {
    const { data: config } = await db
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', accountId)
      .maybeSingle();
    if (!config) {
      await failAllPending(db, broadcastId, 'WhatsApp is not connected for this workspace');
      return result;
    }

    const template = await resolveTemplateRow(
      db,
      accountId,
      broadcast.template_name as string,
      broadcast.template_language as string | null
    );
    if (template.malformed) {
      await failAllPending(
        db,
        broadcastId,
        'Template row is malformed locally — run "Sync from Meta" in Settings, then retry'
      );
      return result;
    }

    const headerMediaUrl = (broadcast.header_media_url as string | null)?.trim();
    const ctx: BroadcastSendContext = {
      phoneNumberId: config.phone_number_id as string,
      accessToken: decrypt(config.access_token as string),
      templateName: broadcast.template_name as string,
      templateLanguage: template.language,
      templateRow: template.row,
      messageParams: headerMediaUrl ? { headerMediaUrl } : undefined,
    };

    // Rows this run already handled. If a row's status update failed
    // it would still read as 'pending'; never send it a second time.
    const handled = new Set<string>();
    let throttled = false;
    const stop = () => throttled || Date.now() >= deadlineMs;

    while (!stop()) {
      const { data: rows, error } = await db
        .from('broadcast_recipients')
        .select('id, template_params, contact:contacts(phone)')
        .eq('broadcast_id', broadcastId)
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(FETCH_SIZE + handled.size)
        .returns<PendingRow[]>();
      if (error) throw new Error(`Recipient load failed: ${error.message}`);

      const fresh = (rows ?? []).filter((r) => !handled.has(r.id)).slice(0, FETCH_SIZE);
      if (fresh.length === 0) {
        if ((rows ?? []).length > 0) {
          console.error(
            '[broadcast-queue] recipients still pending after being sent; stopping to avoid duplicates',
            broadcastId
          );
        }
        break;
      }

      const unsendable: string[] = [];
      const sendable: PlannedRecipient[] = [];
      for (const row of fresh) {
        handled.add(row.id);
        const phone = rowPhone(row);
        if (isValidE164(phone)) {
          sendable.push({ recipientRowId: row.id, phone, params: rowParams(row) });
        } else {
          unsendable.push(row.id);
        }
      }
      if (unsendable.length > 0) {
        await db
          .from('broadcast_recipients')
          .update({ status: 'failed', error_message: 'No valid phone number on contact' })
          .in('id', unsendable);
        result.failed += unsendable.length;
      }

      await runPool(
        sendable,
        SEND_CONCURRENCY,
        async (recipient) => {
          try {
            const outcome = await sendBroadcastRecipient(db, ctx, recipient);
            if (outcome === 'sent') result.sent += 1;
            else if (outcome === 'failed') result.failed += 1;
            else {
              throttled = true;
              // Not sent: let a later run pick it up.
              handled.delete(recipient.recipientRowId);
            }
          } catch (err) {
            console.error('[broadcast-queue] send threw:', err);
          }
        },
        stop
      );

      // Heartbeat: keeps the lock fresh and shows the campaign is moving.
      const now = new Date().toISOString();
      await db
        .from('broadcasts')
        .update({ delivery_locked_at: now, updated_at: now })
        .eq('id', broadcastId);
    }

    if (throttled) result.status = 'throttled';
    else if (Date.now() >= deadlineMs) result.status = 'more';
    return result;
  } finally {
    await releaseBroadcastDelivery(db, broadcastId);
    await finalizeBroadcastStatus(db, broadcastId).catch((err) =>
      console.error('[broadcast-queue] finalize failed:', err)
    );
    // `finalizeBroadcastStatus` leaves 'sending' while rows are pending;
    // report 'done' only when it actually finished.
    if (result.status === 'done') {
      const { count } = await db
        .from('broadcast_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('broadcast_id', broadcastId)
        .eq('status', 'pending');
      if ((count ?? 0) > 0) result.status = 'more';
    }
  }
}

export interface QueueRunSummary {
  started: number;
  runs: { broadcastId: string; status: RunStatus; sent: number; failed: number }[];
}

/**
 * One tick of the scheduled worker: start due scheduled broadcasts,
 * then work through broadcasts that are sending, until the deadline.
 */
export async function runBroadcastQueue(
  db: SupabaseClient,
  deadlineMs: number,
  now: Date = new Date()
): Promise<QueueRunSummary> {
  const nowIso = now.toISOString();

  const { data: started, error: startErr } = await db
    .from('broadcasts')
    .update({ status: 'sending', updated_at: nowIso })
    .eq('status', 'scheduled')
    .lte('scheduled_at', nowIso)
    .select('id');
  if (startErr) throw new Error(`Starting scheduled broadcasts failed: ${startErr.message}`);

  const activeSince = new Date(now.getTime() - AUTO_CONTINUE_WINDOW_MS).toISOString();
  const lockStale = new Date(now.getTime() - DELIVERY_LOCK_STALE_MS).toISOString();
  const { data: due, error: dueErr } = await db
    .from('broadcasts')
    .select('id')
    .eq('status', 'sending')
    .gte('updated_at', activeSince)
    .or(`delivery_locked_at.is.null,delivery_locked_at.lt."${lockStale}"`)
    .order('updated_at', { ascending: true })
    .limit(20);
  if (dueErr) throw new Error(`Loading sending broadcasts failed: ${dueErr.message}`);

  const summary: QueueRunSummary = { started: started?.length ?? 0, runs: [] };
  for (const { id } of due ?? []) {
    if (Date.now() >= deadlineMs) break;
    const run = await runBroadcastDelivery(db, id as string, deadlineMs);
    summary.runs.push({ broadcastId: id as string, ...run });
  }
  return summary;
}
