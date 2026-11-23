// Every number that decides what an AI request may cost lives here.

export type Plan = "free" | "pro";

export const PLANS: Record<
  Plan,
  {
    /** Requests per user per minute (sliding window). */
    requestsPerMinute: number;
    /** Tokens (input + output) per user per UTC day. */
    dailyTokens: number;
    /** Streams one user may have open at once. */
    maxConcurrentStreams: number;
    /** Hard cap on output tokens per request; also the reservation size. */
    maxOutputTokens: number;
  }
> = {
  free: { requestsPerMinute: 10, dailyTokens: 50_000, maxConcurrentStreams: 1, maxOutputTokens: 1_024 },
  pro: { requestsPerMinute: 60, dailyTokens: 1_000_000, maxConcurrentStreams: 3, maxOutputTokens: 4_096 },
};

export type ModelTier = "primary" | "fallback";

/**
 * Prices in USD per 1M tokens. Example values: replace them with your
 * provider's current price sheet. USD per 1M tokens is the same number as
 * micro-dollars per token, which keeps the spend counter in integers.
 */
export const MODELS: Record<ModelTier, { id: string; inputPerM: number; outputPerM: number }> = {
  primary: {
    id: process.env.PRIMARY_MODEL ?? "anthropic/claude-sonnet-5.5",
    inputPerM: Number(process.env.PRIMARY_INPUT_PER_M ?? 3),
    outputPerM: Number(process.env.PRIMARY_OUTPUT_PER_M ?? 15),
  },
  fallback: {
    id: process.env.FALLBACK_MODEL ?? "anthropic/claude-haiku-5.5",
    inputPerM: Number(process.env.FALLBACK_INPUT_PER_M ?? 1),
    outputPerM: Number(process.env.FALLBACK_OUTPUT_PER_M ?? 5),
  },
};

/** Global daily spend across all users, in micro-dollars (1 USD = 1_000_000). */
export const SPEND = {
  /** Above this, new requests run on the fallback model. */
  softCapMicros: Number(process.env.SPEND_SOFT_CAP_USD ?? 20) * 1_000_000,
  /** Above this, new requests are refused until the UTC day rolls over. */
  hardCapMicros: Number(process.env.SPEND_HARD_CAP_USD ?? 50) * 1_000_000,
};

/**
 * How long a stream slot is held before it is presumed dead. Match it to the
 * route's maxDuration: a function that crashed never releases its slot, so
 * the slot has to expire on its own.
 */
export const SLOT_TTL_MS = 120_000;

export const PREFIX = process.env.GUARD_PREFIX ?? "aiguard";
