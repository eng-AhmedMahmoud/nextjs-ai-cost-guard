import { Redis } from "@upstash/redis";

// The client's defaults retry a failed call 5 times with exponential backoff
// (about 4 seconds in total). That is right for a background job and wrong for
// a guard in front of a chat request: fail fast, then decide what to do.
export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  retry: { retries: 1, backoff: () => 50 },
  signal: () => AbortSignal.timeout(2_000),
});
