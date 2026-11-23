import type { UIMessage } from "ai";

/**
 * A deliberately rough input-token estimate: about 4 characters per token for
 * English text, rounded up, plus a small per-message overhead. It only sizes
 * the reservation; settle() replaces it with the provider's real count. Swap
 * in a real tokenizer if your users write mostly code or non-Latin scripts,
 * where 4 chars/token undercounts.
 */
export function estimateInputTokens(messages: UIMessage[], system = ""): number {
  let chars = system.length;
  for (const m of messages) {
    for (const part of m.parts) {
      if (part.type === "text") chars += part.text.length;
    }
  }
  return Math.ceil(chars / 4) + messages.length * 8;
}

/** Keep only the last N messages; the history is what you pay for on every turn. */
export function trimHistory(messages: UIMessage[], keep = 12): UIMessage[] {
  return messages.length > keep ? messages.slice(-keep) : messages;
}
