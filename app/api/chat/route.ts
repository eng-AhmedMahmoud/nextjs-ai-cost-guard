import { after } from "next/server";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { admitChat, refusalResponse } from "@/lib/guard";
import { estimateInputTokens, trimHistory } from "@/lib/estimate";
import { currentUser } from "@/lib/identity";
import { modelFor } from "@/lib/model";

// Keep in step with SLOT_TTL_MS in lib/config.ts.
export const maxDuration = 120;

const SYSTEM = "You are a concise assistant. Answer in at most three short paragraphs.";

export async function POST(req: Request) {
  const { userId, plan } = await currentUser();
  const body = (await req.json().catch(() => null)) as { messages?: UIMessage[] } | null;
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return Response.json({ error: "bad_request", message: "messages must be a non-empty array" }, { status: 400 });
  }
  const messages = trimHistory(body.messages);

  const admission = await admitChat({
    userId,
    plan,
    estimatedInputTokens: estimateInputTokens(messages, SYSTEM),
  });
  if (!admission.ok) return refusalResponse(admission);
  const { lease, headers } = admission;

  // settle() runs from stream callbacks, after the response has started.
  // after() keeps the function alive until the Redis write lands.
  after(() => lease.done);

  const result = streamText({
    model: modelFor(lease.tier),
    system: SYSTEM,
    messages: await convertToModelMessages(messages),
    maxOutputTokens: lease.maxOutputTokens,
    abortSignal: req.signal,
    onEnd: ({ totalUsage }) => lease.settle({ kind: "finished", usage: totalUsage }),
    onAbort: () => lease.settle({ kind: "aborted" }),
    onError: () => lease.settle({ kind: "failed" }),
  });

  return result.toUIMessageStreamResponse({ headers });
}
