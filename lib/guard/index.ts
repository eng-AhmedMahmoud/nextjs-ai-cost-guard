import { Ratelimit } from "@upstash/ratelimit";
import type { LanguageModelUsage } from "ai";
import { MODELS, PLANS, PREFIX, SLOT_TTL_MS, SPEND, type ModelTier, type Plan } from "@/lib/config";
import { redis } from "@/lib/redis";
import { admitScript, settleScript } from "./scripts";

const DAY_TTL_S = 60 * 60 * 48;

// One limiter per plan. Created at module scope so the in-memory
// ephemeralCache survives across requests on a warm instance and
// already-blocked users are refused without a Redis call.
const requestLimiters: Record<Plan, Ratelimit> = {
  free: new Ratelimit({
    redis,
    prefix: `${PREFIX}:rl:free`,
    limiter: Ratelimit.slidingWindow(PLANS.free.requestsPerMinute, "1 m"),
    timeout: 1_500,
  }),
  pro: new Ratelimit({
    redis,
    prefix: `${PREFIX}:rl:pro`,
    limiter: Ratelimit.slidingWindow(PLANS.pro.requestsPerMinute, "1 m"),
    timeout: 1_500,
  }),
};

export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

export function keysFor(userId: string, day = utcDay()) {
  return {
    slots: `${PREFIX}:slots:${userId}`,
    tokens: `${PREFIX}:tokens:${userId}:${day}`,
    spend: `${PREFIX}:spend:${day}`,
  };
}

/** Cost in micro-dollars. USD per 1M tokens equals micro-dollars per token. */
export function costMicros(tier: ModelTier, inputTokens: number, outputTokens: number) {
  const m = MODELS[tier];
  return Math.ceil(inputTokens * m.inputPerM + outputTokens * m.outputPerM);
}

export type Refusal = {
  ok: false;
  status: 429 | 503;
  reason: "rate_limited" | "too_many_streams" | "token_budget" | "spend_cap" | "guard_unavailable";
  message: string;
  retryAfterSeconds: number;
};

export type Outcome =
  | { kind: "finished"; usage: LanguageModelUsage }
  | { kind: "aborted" }
  | { kind: "failed" };

export type Lease = {
  id: string;
  tier: ModelTier;
  maxOutputTokens: number;
  reservedTokens: number;
  tokensLeft: number;
  /** Settles exactly once; later calls return the first call's promise. */
  settle(outcome: Outcome): Promise<void>;
  /** Resolves when settle has written to Redis (or failed trying). */
  done: Promise<void>;
};

const secondsUntil = (ms: number) => Math.max(1, Math.ceil((ms - Date.now()) / 1000));
const secondsUntilUtcMidnight = () => {
  const d = new Date();
  return secondsUntil(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
};

export async function admitChat(opts: {
  userId: string;
  plan: Plan;
  estimatedInputTokens: number;
}): Promise<{ ok: true; lease: Lease; headers: Record<string, string> } | Refusal> {
  const plan = PLANS[opts.plan];

  // Layer 1: request rate. Cheap, and it sheds bursts before any other work.
  let rl;
  try {
    rl = await requestLimiters[opts.plan].limit(opts.userId);
  } catch {
    rl = null;
  }
  // On timeout @upstash/ratelimit returns success: true with reason "timeout"
  // (fail open). A route that spends money should fail closed instead.
  if (!rl || rl.reason === "timeout") {
    return { ok: false, status: 503, reason: "guard_unavailable", message: "Usage limits are unavailable right now. Try again shortly.", retryAfterSeconds: 5 };
  }
  if (!rl.success) {
    return { ok: false, status: 429, reason: "rate_limited", message: "Too many requests. Slow down a little.", retryAfterSeconds: secondsUntil(rl.reset) };
  }

  // Layers 2-4 in one atomic round trip: spend cap, stream slots, token budget.
  const leaseId = crypto.randomUUID();
  const reserve = opts.estimatedInputTokens + plan.maxOutputTokens;
  const keys = keysFor(opts.userId);
  let code: number, tokensLeft: number, spend: number, degraded: number;
  try {
    [code, tokensLeft, spend, degraded] = await admitScript.exec(
      [keys.slots, keys.tokens, keys.spend],
      [Date.now(), SLOT_TTL_MS, plan.maxConcurrentStreams, leaseId, reserve, plan.dailyTokens, DAY_TTL_S, SPEND.softCapMicros, SPEND.hardCapMicros].map(String),
    );
  } catch {
    return { ok: false, status: 503, reason: "guard_unavailable", message: "Usage limits are unavailable right now. Try again shortly.", retryAfterSeconds: 5 };
  }

  if (code === 1) {
    return { ok: false, status: 429, reason: "too_many_streams", message: `You already have ${plan.maxConcurrentStreams} response(s) streaming. Wait for one to finish.`, retryAfterSeconds: 5 };
  }
  if (code === 2) {
    return { ok: false, status: 429, reason: "token_budget", message: `Daily token budget reached (${Math.max(0, tokensLeft)} tokens left, this request needs up to ${reserve}).`, retryAfterSeconds: secondsUntilUtcMidnight() };
  }
  if (code === 3) {
    return { ok: false, status: 503, reason: "spend_cap", message: "The assistant has reached today's spending limit. It will be back tomorrow.", retryAfterSeconds: secondsUntilUtcMidnight() };
  }

  const tier: ModelTier = degraded ? "fallback" : "primary";
  let settling: Promise<void> | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const lease: Lease = {
    id: leaseId,
    tier,
    maxOutputTokens: plan.maxOutputTokens,
    reservedTokens: reserve,
    tokensLeft,
    done,
    settle(outcome) {
      settling ??= (async () => {
        let delta = 0;
        let cost = 0;
        if (outcome.kind === "finished") {
          const input = outcome.usage.inputTokens;
          const output = outcome.usage.outputTokens;
          if (input !== undefined && output !== undefined) {
            delta = input + output - reserve;
            cost = costMicros(tier, input, output);
          } else {
            // Provider reported no usage: keep the reservation, charge it.
            cost = costMicros(tier, opts.estimatedInputTokens, plan.maxOutputTokens);
          }
        } else if (outcome.kind === "aborted") {
          // The partial step's usage is unknown. Charge the full reservation:
          // it is the only number that is never too low.
          cost = costMicros(tier, opts.estimatedInputTokens, plan.maxOutputTokens);
        } else {
          // Provider errors mostly happen before generation starts.
          // Refund rather than bill users for an upstream outage.
          delta = -reserve;
        }
        try {
          await settleScript.exec([keys.slots, keys.tokens, keys.spend], [leaseId, delta, cost, DAY_TTL_S].map(String));
        } catch (err) {
          // The slot expires on its own after SLOT_TTL_MS; the reservation
          // stays charged. Both failure modes over-count, never under-count.
          console.error("[guard] settle failed", err);
        } finally {
          resolveDone();
        }
      })();
      return settling;
    },
  };

  const headers = {
    "X-RateLimit-Limit": String(rl.limit),
    "X-RateLimit-Remaining": String(rl.remaining),
    "X-RateLimit-Reset": String(Math.ceil(rl.reset / 1000)),
    "X-Token-Budget-Remaining": String(Math.max(0, tokensLeft)),
    "X-Model-Tier": tier,
  };
  return { ok: true, lease, headers };
}

export async function usageSnapshot(userId: string, plan: Plan) {
  const keys = keysFor(userId);
  const [rl, [tokens, spend, slots]] = await Promise.all([
    requestLimiters[plan].getRemaining(userId),
    Promise.all([
      redis.get<number>(keys.tokens),
      redis.get<number>(keys.spend),
      redis.zcount(keys.slots, Date.now() - SLOT_TTL_MS, "+inf"),
    ]),
  ]);
  const p = PLANS[plan];
  return {
    plan,
    requests: { remaining: rl.remaining, limit: p.requestsPerMinute, resetAt: rl.reset },
    tokens: { used: tokens ?? 0, limit: p.dailyTokens },
    streams: { open: slots, limit: p.maxConcurrentStreams },
    spend: { micros: spend ?? 0, softCapMicros: SPEND.softCapMicros, hardCapMicros: SPEND.hardCapMicros },
    tier: (spend ?? 0) >= SPEND.softCapMicros ? "fallback" : "primary",
  };
}

export function refusalResponse(r: Refusal) {
  return Response.json(
    { error: r.reason, message: r.message },
    { status: r.status, headers: { "Retry-After": String(r.retryAfterSeconds) } },
  );
}
