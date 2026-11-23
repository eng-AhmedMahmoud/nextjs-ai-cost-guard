import { existsSync, readFileSync } from "node:fs";

// Load .env.local without a dependency. Real env vars win.
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    "Tests need a Redis REST endpoint. Set UPSTASH_REDIS_REST_URL/TOKEN in .env.local, " +
      "or run `docker compose up -d` and use http://localhost:8079 with token local_token.",
  );
}

// Every run gets its own key namespace, so runs never see each other's counters.
process.env.GUARD_PREFIX = `test:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
// Small caps so the spend tests do not need thousands of requests.
process.env.SPEND_SOFT_CAP_USD = "0.05";
process.env.SPEND_HARD_CAP_USD = "0.10";
