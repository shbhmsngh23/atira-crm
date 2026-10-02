import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetRateLimitForTests,
  checkRateLimit,
  rateLimitResponse,
  redisConfig,
} from "./rate-limit";

const OPTS = { limit: 3, windowMs: 60_000 };

describe("checkRateLimit (in-memory)", () => {
  beforeEach(() => {
    __resetRateLimitForTests();
  });

  it("permits the first request and decrements remaining", async () => {
    const result = await checkRateLimit("user:1", OPTS);
    expect(result).toMatchObject({
      success: true,
      remaining: 2,
      limit: 3,
    });
    expect(result.reset).toBeGreaterThan(Date.now());
  });

  it("permits exactly `limit` requests then rejects the next", async () => {
    expect((await checkRateLimit("user:1", OPTS)).success).toBe(true);
    expect((await checkRateLimit("user:1", OPTS)).success).toBe(true);
    expect((await checkRateLimit("user:1", OPTS)).success).toBe(true);
    const over = await checkRateLimit("user:1", OPTS);
    expect(over.success).toBe(false);
    expect(over.remaining).toBe(0);
  });

  it("keeps separate counters per key", async () => {
    await checkRateLimit("user:1", OPTS);
    await checkRateLimit("user:1", OPTS);
    await checkRateLimit("user:1", OPTS);
    // user:1 is at the cap, user:2 should still be unaffected.
    const other = await checkRateLimit("user:2", OPTS);
    expect(other.success).toBe(true);
    expect(other.remaining).toBe(2);
  });

  it("opens a fresh window after `windowMs` elapses", async () => {
    vi.useFakeTimers();
    try {
      const t0 = new Date("2026-05-01T00:00:00Z").getTime();
      vi.setSystemTime(t0);
      __resetRateLimitForTests();

      await checkRateLimit("user:1", OPTS);
      await checkRateLimit("user:1", OPTS);
      await checkRateLimit("user:1", OPTS);
      expect((await checkRateLimit("user:1", OPTS)).success).toBe(false);

      // Jump just past the window.
      vi.setSystemTime(t0 + OPTS.windowMs + 1);
      const refreshed = await checkRateLimit("user:1", OPTS);
      expect(refreshed.success).toBe(true);
      expect(refreshed.remaining).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("checkRateLimit (Redis)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    __resetRateLimitForTests();
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example.upstash.io/");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "secret-token");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const redisReply = (count: number) =>
    new Response(JSON.stringify([{ result: count }, { result: 1 }]), { status: 200 });

  it("counts in Redis with one pipelined INCR + PEXPIRE", async () => {
    fetchMock.mockResolvedValueOnce(redisReply(1));
    const result = await checkRateLimit("user:1", OPTS);

    expect(result).toMatchObject({ success: true, remaining: 2, limit: 3 });
    expect(result.reset % OPTS.windowMs).toBe(0);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://redis.example.upstash.io/pipeline");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
    const commands = JSON.parse(init.body as string) as string[][];
    expect(commands[0][0]).toBe("INCR");
    expect(commands[0][1]).toMatch(/^rl:user:1:\d+$/);
    expect(commands[1][0]).toBe("PEXPIRE");
    expect(commands[1][1]).toBe(commands[0][1]);
  });

  it("rejects once the shared count passes the limit", async () => {
    fetchMock.mockResolvedValueOnce(redisReply(4));
    const result = await checkRateLimit("user:1", OPTS);
    expect(result).toMatchObject({ success: false, remaining: 0 });
  });

  it("falls back to in-memory limits when Redis is unreachable", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const results = [];
    for (let i = 0; i < 4; i++) results.push(await checkRateLimit("user:1", OPTS));

    expect(results.map((r) => r.success)).toEqual([true, true, true, false]);
    // Logged once, not on every request.
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("falls back when Redis answers with an error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([{ error: "WRONGTYPE" }]), { status: 200 }),
    );
    expect((await checkRateLimit("user:1", OPTS)).success).toBe(true);
  });
});

describe("redisConfig", () => {
  it("reads Upstash or Vercel KV variables and trims trailing slashes", () => {
    expect(
      redisConfig({ UPSTASH_REDIS_REST_URL: "https://a.io/", UPSTASH_REDIS_REST_TOKEN: "t" }),
    ).toEqual({ url: "https://a.io", token: "t" });
    expect(
      redisConfig({ KV_REST_API_URL: "https://kv.io", KV_REST_API_TOKEN: "k" }),
    ).toEqual({ url: "https://kv.io", token: "k" });
    expect(redisConfig({ UPSTASH_REDIS_REST_URL: "https://a.io" })).toBeNull();
  });
});

describe("rateLimitResponse", () => {
  it("returns a 429 with retry / X-RateLimit headers", async () => {
    const reset = Date.now() + 30_000;
    const res = rateLimitResponse({
      success: false,
      remaining: 0,
      reset,
      limit: 60,
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/rate limit/i);
  });

  it("clamps Retry-After to a minimum of 1 second", () => {
    // Reset already in the past — the ceiling math would otherwise give 0.
    const res = rateLimitResponse({
      success: false,
      remaining: 0,
      reset: Date.now() - 5_000,
      limit: 10,
    });
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
  });
});

describe("RATE_LIMITS presets", () => {
  it("send and broadcast are budgeted per minute", async () => {
    __resetRateLimitForTests();
    // Importing here so the presets stay close to their assertions.
    const { RATE_LIMITS } = await import("./rate-limit");
    expect(RATE_LIMITS.send.windowMs).toBe(60_000);
    expect(RATE_LIMITS.broadcast.windowMs).toBe(60_000);
  });
});

afterEach(() => {
  __resetRateLimitForTests();
});
