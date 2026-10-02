import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// ------------------------------------------------------------------
// Module stubs. Meta, the template lookup, encryption, billing and the
// delivery lock are covered by their own tests; here they are knobs.
// ------------------------------------------------------------------
const sendTemplateMessage = vi.fn();
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()),
  sendTemplateMessage: (args: unknown) => sendTemplateMessage(args),
}));
vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: vi.fn(async () => ({ row: null, language: 'en_US', malformed: false })),
}));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'token' }));

const usable = { value: true };
vi.mock('@/lib/billing/server', () => ({
  loadBillingState: vi.fn(async () => ({ usable: usable.value })),
}));

const claim = vi.fn(async () => true);
const release = vi.fn(async () => {});
vi.mock('@/lib/whatsapp/broadcast-resume', () => ({
  claimBroadcastDelivery: () => claim(),
  releaseBroadcastDelivery: () => release(),
  DELIVERY_LOCK_STALE_MS: 30 * 60 * 1000,
}));

const { MetaApiError } = await import('@/lib/whatsapp/meta-api');
const { runBroadcastDelivery, runPool } = await import('./broadcast-queue');

// ------------------------------------------------------------------
// A tiny in-memory stand-in for the Supabase query builder: enough of
// select / update / eq / in / order / limit / maybeSingle / count.
// ------------------------------------------------------------------
type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>): SupabaseClient {
  class Query {
    private filters: ((r: Row) => boolean)[] = [];
    private patch: Row | null = null;
    private head = false;
    private max: number | null = null;
    constructor(private table: string) {}
    select(_cols?: string, opts?: { head?: boolean }) {
      if (opts?.head) this.head = true;
      return this;
    }
    update(patch: Row) {
      this.patch = patch;
      return this;
    }
    eq(col: string, v: unknown) {
      this.filters.push((r) => r[col] === v);
      return this;
    }
    in(col: string, vs: unknown[]) {
      this.filters.push((r) => vs.includes(r[col]));
      return this;
    }
    order() {
      return this;
    }
    limit(n: number) {
      this.max = n;
      return this;
    }
    returns() {
      return this;
    }
    private rows() {
      return (tables[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)));
    }
    maybeSingle() {
      return Promise.resolve({ data: this.rows()[0] ?? null, error: null });
    }
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      const rows = this.rows();
      let out: unknown;
      if (this.patch) {
        rows.forEach((r) => Object.assign(r, this.patch));
        out = { data: rows, error: null };
      } else if (this.head) {
        out = { count: rows.length, error: null };
      } else {
        out = { data: this.max === null ? rows : rows.slice(0, this.max), error: null };
      }
      return Promise.resolve(out).then(resolve, reject);
    }
  }
  return { from: (table: string) => new Query(table) } as unknown as SupabaseClient;
}

function setup(opts: { status?: string; phones?: string[]; headerMediaUrl?: string | null } = {}) {
  const phones = opts.phones ?? ['+919800000001', '+919800000002', '+919800000003'];
  const tables: Record<string, Row[]> = {
    broadcasts: [
      {
        id: 'b1',
        account_id: 'acc',
        status: opts.status ?? 'sending',
        template_name: 'promo',
        template_language: 'en_US',
        header_media_url: opts.headerMediaUrl ?? null,
      },
    ],
    broadcast_recipients: phones.map((phone, i) => ({
      id: `r${i}`,
      broadcast_id: 'b1',
      status: 'pending',
      template_params: [`Name ${i}`],
      contact: { phone },
    })),
    whatsapp_config: [{ account_id: 'acc', phone_number_id: 'pn', access_token: 'enc' }],
  };
  return { tables, db: fakeDb(tables) };
}

const FAR = () => Date.now() + 60_000;

beforeEach(() => {
  sendTemplateMessage.mockReset();
  let n = 0;
  sendTemplateMessage.mockImplementation(async () => ({ messageId: `wamid.${++n}` }));
  claim.mockReset().mockResolvedValue(true);
  release.mockClear();
  usable.value = true;
});

describe('runBroadcastDelivery', () => {
  it('sends every pending recipient and finishes the broadcast', async () => {
    const { tables, db } = setup();
    const result = await runBroadcastDelivery(db, 'b1', FAR());

    expect(result).toEqual({ status: 'done', sent: 3, failed: 0 });
    expect(tables.broadcast_recipients.every((r) => r.status === 'sent')).toBe(true);
    expect(tables.broadcasts[0].status).toBe('sent');
    expect(sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: '919800000001', params: ['Name 0'], phoneNumberId: 'pn' })
    );
    expect(release).toHaveBeenCalled();
  });

  it('fails recipients without a valid phone instead of leaving them pending', async () => {
    const { tables, db } = setup({ phones: ['+919800000001', 'not-a-phone'] });
    const result = await runBroadcastDelivery(db, 'b1', FAR());

    expect(result).toMatchObject({ status: 'done', sent: 1, failed: 1 });
    expect(tables.broadcast_recipients[1]).toMatchObject({
      status: 'failed',
      error_message: 'No valid phone number on contact',
    });
  });

  it('stops on a Meta throughput error and leaves the rest pending', async () => {
    sendTemplateMessage.mockReset();
    sendTemplateMessage
      .mockResolvedValueOnce({ messageId: 'wamid.1' })
      .mockRejectedValue(new MetaApiError('Rate limit hit', { code: 130429, httpStatus: 400 }));
    const { tables, db } = setup();
    const result = await runBroadcastDelivery(db, 'b1', FAR());

    expect(result.status).toBe('throttled');
    expect(result.sent).toBe(1);
    expect(tables.broadcast_recipients.filter((r) => r.status === 'pending').length).toBe(2);
    expect(tables.broadcast_recipients.some((r) => r.status === 'failed')).toBe(false);
    expect(tables.broadcasts[0].status).toBe('sending');
  });

  it('writes off a recipient on an ordinary Meta error', async () => {
    sendTemplateMessage.mockReset();
    sendTemplateMessage.mockRejectedValue(
      new MetaApiError('Message undeliverable', { code: 131026, httpStatus: 400 })
    );
    const { tables, db } = setup({ phones: ['+919800000001'] });
    const result = await runBroadcastDelivery(db, 'b1', FAR());

    expect(result).toMatchObject({ status: 'done', failed: 1 });
    expect(tables.broadcast_recipients[0]).toMatchObject({
      status: 'failed',
      error_message: 'Message undeliverable',
    });
    expect(tables.broadcasts[0].status).toBe('failed');
  });

  it('leaves everything for the next run once the deadline has passed', async () => {
    const { tables, db } = setup();
    const result = await runBroadcastDelivery(db, 'b1', Date.now() - 1);

    expect(result.status).toBe('more');
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    expect(tables.broadcasts[0].status).toBe('sending');
  });

  it('sends nothing for a workspace whose plan has lapsed', async () => {
    usable.value = false;
    const { db } = setup();
    expect((await runBroadcastDelivery(db, 'b1', FAR())).status).toBe('plan_inactive');
    expect(claim).not.toHaveBeenCalled();
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('backs off when another run holds the lock', async () => {
    claim.mockResolvedValueOnce(false);
    const { db } = setup();
    expect((await runBroadcastDelivery(db, 'b1', FAR())).status).toBe('locked');
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('ignores broadcasts that are not sending (draft, scheduled, finished)', async () => {
    for (const status of ['draft', 'scheduled', 'sent']) {
      const { db } = setup({ status });
      expect((await runBroadcastDelivery(db, 'b1', FAR())).status).toBe('not_sending');
    }
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('sends the stored header media with every message', async () => {
    const { db } = setup({ phones: ['+919800000001'], headerMediaUrl: ' https://cdn.example/x.jpg ' });
    await runBroadcastDelivery(db, 'b1', FAR());
    expect(sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageParams: { headerMediaUrl: 'https://cdn.example/x.jpg' } })
    );
  });

  it('fails every pending recipient when WhatsApp is not connected', async () => {
    const { tables, db } = setup();
    tables.whatsapp_config = [];
    await runBroadcastDelivery(db, 'b1', FAR());
    expect(tables.broadcast_recipients.every((r) => r.status === 'failed')).toBe(true);
    expect(tables.broadcasts[0].status).toBe('failed');
  });
});

describe('runPool', () => {
  it('never runs more than the limit at once and stops when asked', async () => {
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    await runPool(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async (i) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 1));
        done.push(i);
        active--;
      },
      () => done.length >= 10
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(done.length).toBeGreaterThanOrEqual(10);
    expect(done.length).toBeLessThan(20);
  });
});
