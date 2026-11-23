// Which streamText callbacks fire, and with what, for the three ways a stream
// ends. The guard's settle() wiring depends on exactly this.
import { streamText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

async function run(opts: { failAt?: number; abortAfterChunks?: number }) {
  vi.resetModules();
  process.env.MOCK_CHUNK_DELAY_MS = "5";
  if (opts.failAt !== undefined) process.env.MOCK_FAIL_AT_CHUNK = String(opts.failAt);
  const { modelFor } = await import("@/lib/model");
  const calls: string[] = [];
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  const controller = new AbortController();
  const result = streamText({
    model: modelFor("primary"),
    prompt: "hello",
    abortSignal: controller.signal,
    onEnd: ({ totalUsage }) => {
      calls.push("end");
      usage = totalUsage;
    },
    onAbort: () => {
      calls.push("abort");
    },
    onError: () => {
      calls.push("error");
    },
  });
  let chunks = 0;
  try {
    for await (const _ of result.textStream) {
      if (opts.abortAfterChunks !== undefined && ++chunks >= opts.abortAfterChunks) controller.abort();
    }
  } catch {
    // aborts and errors surface here; the callbacks are what we are checking
  }
  await new Promise((r) => setTimeout(r, 50));
  return { calls, usage };
}

afterEach(() => {
  delete process.env.MOCK_FAIL_AT_CHUNK;
});

describe("streamText callbacks (AI SDK 7)", () => {
  it("a finished stream calls onEnd once, with the provider's usage", async () => {
    const { calls, usage } = await run({});
    expect(calls).toEqual(["end"]);
    expect(usage?.inputTokens).toBeGreaterThan(0);
    expect(usage?.outputTokens).toBeGreaterThan(0);
  });

  it("an aborted stream calls onAbort and not onEnd", async () => {
    const { calls } = await run({ abortAfterChunks: 3 });
    expect(calls).toContain("abort");
    expect(calls).not.toContain("end");
  });

  it("a provider error mid-stream calls onError and THEN onEnd, so settle must be idempotent", async () => {
    const { calls } = await run({ failAt: 6 });
    expect(calls).toEqual(["error", "end"]);
  });
});
