import { afterAll, describe, expect, it, vi } from "vitest";
import { PLANS, PREFIX, SLOT_TTL_MS, SPEND } from "@/lib/config";
import { admitChat, costMicros, keysFor, type Lease } from "@/lib/guard";
import { redis } from "@/lib/redis";

const free = PLANS.free;
let n = 0;
const newUser = () => `user:t${++n}-${Math.random().toString(36).slice(2, 8)}`;
const usage = (inputTokens: number, outputTokens: number) =>
  ({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }) as never;

async function admitOk(userId: string, input = 100, plan: "free" | "pro" = "free"): Promise<Lease> {
  const r = await admitChat({ userId, plan, estimatedInputTokens: input });
  if (!r.ok) throw new Error(`expected admit, got ${r.reason}`);
  return r.lease;
}

afterAll(async () => {
  // Clean up this run's keys.
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, { match: `${PREFIX}:*`, count: 500 });
    if (keys.length) await redis.del(...keys);
    cursor = String(next);
  } while (cursor !== "0");
});

describe("token budget", () => {
  it("reserves estimated input + maxOutputTokens at admission", async () => {
    const user = newUser();
    const lease = await admitOk(user, 200);
    expect(lease.reservedTokens).toBe(200 + free.maxOutputTokens);
    expect(await redis.get<number>(keysFor(user).tokens)).toBe(200 + free.maxOutputTokens);
    expect(lease.tokensLeft).toBe(free.dailyTokens - lease.reservedTokens);
    await lease.settle({ kind: "finished", usage: usage(180, 300) });
  });

  it("settle replaces the reservation with the real token count", async () => {
    const user = newUser();
    const lease = await admitOk(user, 200);
    await lease.settle({ kind: "finished", usage: usage(180, 300) });
    expect(await redis.get<number>(keysFor(user).tokens)).toBe(480);
  });

  it("refuses a request whose reservation does not fit, and the refusal reserves nothing", async () => {
    const user = newUser();
    const k = keysFor(user);
    await redis.set(k.tokens, free.dailyTokens - 500);
    const r = await admitChat({ userId: user, plan: "free", estimatedInputTokens: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("token_budget");
      expect(r.status).toBe(429);
    }
    expect(await redis.get<number>(k.tokens)).toBe(free.dailyTokens - 500);
    // Nothing was reserved, so the slot is free too.
    expect(await redis.zcard(k.slots)).toBe(0);
  });

  it("an aborted stream keeps the full reservation; a failed one is refunded", async () => {
    const a = newUser();
    const la = await admitOk(a, 100);
    await la.settle({ kind: "aborted" });
    expect(await redis.get<number>(keysFor(a).tokens)).toBe(100 + free.maxOutputTokens);

    const b = newUser();
    const lb = await admitOk(b, 100);
    await lb.settle({ kind: "failed" });
    expect(await redis.get<number>(keysFor(b).tokens)).toBe(0);
  });

  it("settle runs once even when several callbacks fire", async () => {
    const user = newUser();
    const lease = await admitOk(user, 100);
    await Promise.all([
      lease.settle({ kind: "finished", usage: usage(90, 50) }),
      lease.settle({ kind: "aborted" }),
      lease.settle({ kind: "failed" }),
    ]);
    expect(await redis.get<number>(keysFor(user).tokens)).toBe(140);
  });
});

describe("stream slots", () => {
  it("refuses a second concurrent stream on the free plan until the first settles", async () => {
    const user = newUser();
    const first = await admitOk(user);
    const second = await admitChat({ userId: user, plan: "free", estimatedInputTokens: 100 });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("too_many_streams");

    await first.settle({ kind: "finished", usage: usage(100, 100) });
    const third = await admitOk(user);
    await third.settle({ kind: "finished", usage: usage(100, 100) });
  });

  it("allows three concurrent streams on the pro plan", async () => {
    const user = newUser();
    const leases = [await admitOk(user, 100, "pro"), await admitOk(user, 100, "pro"), await admitOk(user, 100, "pro")];
    const fourth = await admitChat({ userId: user, plan: "pro", estimatedInputTokens: 100 });
    expect(fourth.ok).toBe(false);
    await Promise.all(leases.map((l) => l.settle({ kind: "failed" })));
  });

  it("a slot whose function died without settling expires after SLOT_TTL_MS", async () => {
    const user = newUser();
    // A lease from a crashed function: taken long ago, never released.
    await redis.zadd(keysFor(user).slots, { score: Date.now() - SLOT_TTL_MS - 1_000, member: "dead-lease" });
    const lease = await admitOk(user);
    expect(await redis.zscore(keysFor(user).slots, "dead-lease")).toBeNull();
    await lease.settle({ kind: "failed" });
  });
});

describe("spend circuit breaker", () => {
  // The spend counter is global, so these tests run in order on one day key.
  const spendKey = keysFor("nobody").spend;

  it("switches new requests to the fallback tier past the soft cap", async () => {
    await redis.set(spendKey, SPEND.softCapMicros);
    const lease = await admitOk(newUser());
    expect(lease.tier).toBe("fallback");
    await lease.settle({ kind: "failed" });
  });

  it("adds each request's cost to today's spend at settle", async () => {
    await redis.set(spendKey, 0);
    const lease = await admitOk(newUser());
    expect(lease.tier).toBe("primary");
    await lease.settle({ kind: "finished", usage: usage(1_000, 500) });
    expect(await redis.get<number>(spendKey)).toBe(costMicros("primary", 1_000, 500));
  });

  it("refuses everything past the hard cap with 503", async () => {
    await redis.set(spendKey, SPEND.hardCapMicros);
    const r = await admitChat({ userId: newUser(), plan: "free", estimatedInputTokens: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("spend_cap");
      expect(r.status).toBe(503);
    }
    await redis.set(spendKey, 0);
  });
});

describe("request rate limit", () => {
  it(`refuses request ${free.requestsPerMinute + 1} inside one minute`, async () => {
    const user = newUser();
    for (let i = 0; i < free.requestsPerMinute; i++) {
      const lease = await admitOk(user, 10);
      await lease.settle({ kind: "failed" });
    }
    const r = await admitChat({ userId: user, plan: "free", estimatedInputTokens: 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("rate_limited");
      expect(r.retryAfterSeconds).toBeGreaterThan(0);
    }
  }, 60_000);
});

describe("when Redis is unreachable", () => {
  it("fails closed with 503 instead of letting the request through", async () => {
    vi.resetModules();
    const saved = process.env.UPSTASH_REDIS_REST_URL;
    process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:9";
    try {
      const { admitChat: admitDown } = await import("@/lib/guard");
      const started = Date.now();
      const r = await admitDown({ userId: newUser(), plan: "free", estimatedInputTokens: 10 });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("guard_unavailable");
        expect(r.status).toBe(503);
      }
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      process.env.UPSTASH_REDIS_REST_URL = saved;
      vi.resetModules();
    }
  });
});
