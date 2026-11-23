import { simulateReadableStream, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { MODELS, type ModelTier } from "@/lib/config";

const hasGateway = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);

/** A real model through the AI Gateway when a key is set, the mock otherwise. */
export function modelFor(tier: ModelTier): LanguageModel {
  return hasGateway ? MODELS[tier].id : mockModel(tier);
}

export const usingMock = !hasGateway;

const ANSWER =
  "This reply comes from the built-in mock model, so the demo runs without an API key. " +
  "Every guard in front of it is real: the request limit, the daily token budget, the " +
  "stream slot and the spend counter all live in Upstash Redis. Open a second tab and send " +
  "a message while this one is still streaming to see the concurrency slot refuse it, or " +
  "keep chatting until the token budget runs out. Usage is reported at the end of the " +
  "stream, exactly like a real provider, and the route settles the reservation from it.";

/** Streams ANSWER word by word and reports usage in the finish part. */
function mockModel(tier: ModelTier) {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: `mock-${tier}`,
    doStream: async (options) => {
      const promptChars = JSON.stringify(options.prompt).length;
      const words = (tier === "fallback" ? `[fallback tier] ${ANSWER}` : ANSWER).split(/(?<= )/);
      const delay = Number(process.env.MOCK_CHUNK_DELAY_MS ?? 60);
      const failAt = process.env.MOCK_FAIL_AT_CHUNK ? Number(process.env.MOCK_FAIL_AT_CHUNK) : -1;
      const inputTokens = Math.ceil(promptChars / 4);
      const outputTokens = Math.ceil(ANSWER.length / 4);
      const chunks = [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "t1" },
        ...words.map((delta) => ({ type: "text-delta" as const, id: "t1", delta })),
        { type: "text-end" as const, id: "t1" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: {
            inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
          },
        },
      ];
      if (failAt >= 0) chunks.splice(failAt, chunks.length - failAt, { type: "error", error: new Error("mock provider failure") } as never);
      return {
        stream: simulateReadableStream({ chunks, chunkDelayInMs: delay, initialDelayInMs: 150 }),
      };
    },
  });
}
