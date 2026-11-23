#!/usr/bin/env node
// End-to-end smoke against a running server (mock model):
//   BASE_URL=https://ai-cost-guard.localhost:1355 node scripts/smoke.mjs
// Checks a full stream settles to real usage, a second concurrent stream is
// refused, and an aborted stream keeps its reservation and frees its slot.

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
let cookie = "";
let failed = 0;

const check = (ok, label, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  (${extra})` : ""}`);
  if (!ok) failed++;
};

async function req(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { "Content-Type": "application/json", cookie, ...(init.headers ?? {}) } });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = [cookie, ...set.map((c) => c.split(";")[0])].filter(Boolean).join("; ");
  return res;
}

const usage = async () => (await req("/api/usage")).json();
const chatBody = (text) => JSON.stringify({ messages: [{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const u0 = await usage();
check(u0.tokens.used === 0 && u0.streams.open === 0, "fresh demo user starts at zero", `plan=${u0.plan} mock=${u0.mockModel}`);

// 1. A full stream settles to the real token count, not the reservation.
const r1 = await req("/api/chat", { method: "POST", body: chatBody("Explain token budgets in one line.") });
const reserved = Number(r1.headers.get("x-token-budget-remaining"));
const text1 = await r1.text();
check(r1.status === 200 && text1.includes("text-delta"), "chat streams a UI message stream", `status=${r1.status}`);
check(r1.headers.get("x-model-tier") === "primary", "primary model tier while under the soft cap");
await sleep(600);
const u1 = await usage();
check(u1.tokens.used > 0 && u1.tokens.used < 1024, "settled usage is the real count, below the 1,024-token reservation", `used=${u1.tokens.used}, remaining header at admit=${reserved}`);
check(u1.streams.open === 0, "slot released after the stream finished");

// 2. A second stream while the first is open is refused.
const ctrl = new AbortController();
const r2 = await req("/api/chat", { method: "POST", body: chatBody("long one"), signal: ctrl.signal });
const reader = r2.body.getReader();
await reader.read();
const r3 = await req("/api/chat", { method: "POST", body: chatBody("second tab") });
const j3 = await r3.json();
check(r3.status === 429 && j3.error === "too_many_streams", "second concurrent stream refused with 429", `status=${r3.status} error=${j3.error} retry-after=${r3.headers.get("retry-after")}`);

// 3. Aborting mid-stream keeps the full reservation and frees the slot.
const before = (await usage()).tokens.used;
ctrl.abort();
await reader.cancel().catch(() => {});
await sleep(1200);
const u3 = await usage();
check(u3.streams.open === 0, "aborted stream released its slot", `open=${u3.streams.open}`);
check(u3.tokens.used === before, "aborted stream kept its full reservation (charged, not refunded)", `before=${before} after=${u3.tokens.used}`);

// 4. Bad input is a 400, not a guard charge.
const r4 = await req("/api/chat", { method: "POST", body: "{}" });
check(r4.status === 400, "empty body rejected with 400");

console.log(failed ? `\n${failed} check(s) failed` : "\nall smoke checks passed");
process.exit(failed ? 1 : 0);
