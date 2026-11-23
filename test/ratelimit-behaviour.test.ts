// Pins down @upstash/ratelimit behaviour the article relies on, so a library
// upgrade that changes it fails here instead of in production.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { describe, expect, it } from "vitest";

const redis = Redis.fromEnv();
const prefix = `${process.env.GUARD_PREFIX}:behaviour`;
const id = () => Math.random().toString(36).slice(2);

describe("@upstash/ratelimit", () => {
  it("fails OPEN when Redis is slow: success is true and reason is 'timeout'", async () => {
    // A server that accepts the request and never answers.
    const sockets = new Set<import("node:net").Socket>();
    const hang = createServer(() => {});
    hang.on("connection", (s) => sockets.add(s));
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
    const { port } = hang.address() as AddressInfo;
    try {
      const slow = new Redis({ url: `http://127.0.0.1:${port}`, token: "x", retry: false });
      const rl = new Ratelimit({ redis: slow, limiter: Ratelimit.slidingWindow(1, "1 m"), timeout: 500, ephemeralCache: false });
      const started = Date.now();
      const res = await rl.limit(id());
      expect(res.success).toBe(true);
      expect(res.reason).toBe("timeout");
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      for (const s of sockets) s.destroy();
      hang.close();
    }
  });

  it("throws when Redis refuses the connection: timeout does not cover errors", async () => {
    const down = new Redis({ url: "http://127.0.0.1:9", token: "x", retry: false });
    const rl = new Ratelimit({ redis: down, limiter: Ratelimit.slidingWindow(1, "1 m"), timeout: 500, ephemeralCache: false });
    await expect(rl.limit(id())).rejects.toThrow();
  });

  it("rate: n consumes n units per call", async () => {
    const rl = new Ratelimit({ redis, prefix: `${prefix}:rate`, limiter: Ratelimit.slidingWindow(1_000, "1 m"), ephemeralCache: false });
    const user = id();
    const res = await rl.limit(user, { rate: 250 });
    expect(res.success).toBe(true);
    expect(res.remaining).toBe(750);
  });

  // A request too big for what is left: is it refused without consuming?
  // Observed with @upstash/ratelimit 2.2.1: the window algorithms count the
  // refused units, so one oversized request empties the window; tokenBucket
  // refuses without consuming.
  for (const [name, limiter, leftAfter, smallAllowed] of [
    ["fixedWindow", Ratelimit.fixedWindow(1_000, "1 m"), 0, false],
    ["slidingWindow", Ratelimit.slidingWindow(1_000, "1 m"), 0, false],
    ["tokenBucket", Ratelimit.tokenBucket(1_000, "1 m", 1_000), 100, true],
  ] as const) {
    it(`${name}: what an oversized rejected request does to the remaining budget`, async () => {
      const rl = new Ratelimit({ redis, prefix: `${prefix}:${name}`, limiter, ephemeralCache: false });
      const user = id();
      expect((await rl.limit(user, { rate: 900 })).success).toBe(true);
      const big = await rl.limit(user, { rate: 500 });
      expect(big.success).toBe(false);
      const after = await rl.getRemaining(user);
      const small = await rl.limit(user, { rate: 50 });
      expect(after.remaining).toBe(leftAfter);
      expect(small.success).toBe(smallAllowed);
    });
  }
});
