"use client";

import { useChat } from "@ai-sdk/react";
import { useCallback, useEffect, useState } from "react";

type Usage = {
  plan: "free" | "pro";
  requests: { remaining: number; limit: number };
  tokens: { used: number; limit: number };
  streams: { open: number; limit: number };
  spend: { micros: number; softCapMicros: number; hardCapMicros: number };
  tier: "primary" | "fallback";
  mockModel: boolean;
};

function errorText(error: Error | undefined) {
  if (!error) return null;
  try {
    return (JSON.parse(error.message) as { message?: string }).message ?? error.message;
  } catch {
    return error.message;
  }
}

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(4)}`;

function Meter({ label, value, max, detail }: { label: string; value: number; max: number; detail: string }) {
  const pct = Math.min(100, Math.round((value / Math.max(1, max)) * 100));
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="mono">{detail}</span>
      </div>
      <div className="bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
        <div className={`fill ${pct >= 90 ? "hot" : pct >= 60 ? "warm" : ""}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Chat() {
  const [input, setInput] = useState("");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [burst, setBurst] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/usage", { cache: "no-store" });
    if (res.ok) setUsage(await res.json());
  }, []);

  const { messages, sendMessage, status, stop, error } = useChat({
    onFinish: () => void refresh(),
    onError: () => void refresh(),
  });
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void refresh(), 1500);
    return () => clearInterval(t);
  }, [busy, refresh]);

  async function setPlan(plan: "free" | "pro") {
    await fetch("/api/usage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan }) });
    await refresh();
  }

  async function fireBurst() {
    setBurst("sending 3 requests at once…");
    const body = JSON.stringify({ messages: [{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: "burst test" }] }] });
    const results = await Promise.all(
      [0, 1, 2].map(async () => {
        const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body });
        if (res.ok) {
          await res.text();
          return "200";
        }
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        return `${res.status} ${j.error ?? ""}`.trim();
      }),
    );
    setBurst(results.join(" · "));
    await refresh();
  }

  return (
    <div className="grid">
      <section className="panel chat" aria-label="Chat">
        <div className="messages">
          {messages.length === 0 && <p className="hint">Ask anything. Watch the guard panel while it streams.</p>}
          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              <span className="who">{m.role === "user" ? "You" : "Assistant"}</span>
              <p>{m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}</p>
            </div>
          ))}
          {error && <p className="err">{errorText(error)}</p>}
        </div>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (!input.trim() || busy) return;
            void sendMessage({ text: input });
            setInput("");
          }}
        >
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Message" aria-label="Message" />
          {busy ? (
            <button type="button" onClick={() => stop()}>
              Stop
            </button>
          ) : (
            <button type="submit">Send</button>
          )}
        </form>
      </section>

      <aside className="panel guards" aria-label="Guards">
        <div className="row">
          <h2>Guards</h2>
          <div className="seg" role="group" aria-label="Plan">
            {(["free", "pro"] as const).map((p) => (
              <button key={p} className={usage?.plan === p ? "on" : ""} onClick={() => void setPlan(p)}>
                {p}
              </button>
            ))}
          </div>
        </div>
        {usage ? (
          <>
            <Meter label="Requests this minute" value={usage.requests.limit - usage.requests.remaining} max={usage.requests.limit} detail={`${usage.requests.limit - usage.requests.remaining} / ${usage.requests.limit}`} />
            <Meter label="Tokens today" value={usage.tokens.used} max={usage.tokens.limit} detail={`${usage.tokens.used.toLocaleString()} / ${usage.tokens.limit.toLocaleString()}`} />
            <Meter label="Open streams" value={usage.streams.open} max={usage.streams.limit} detail={`${usage.streams.open} / ${usage.streams.limit}`} />
            <Meter label="Global spend today" value={usage.spend.micros} max={usage.spend.hardCapMicros} detail={`${usd(usage.spend.micros)} / ${usd(usage.spend.hardCapMicros)}`} />
            <p className="tier">
              Model tier: <strong>{usage.tier}</strong>
              {usage.mockModel && <span className="tag">mock model</span>}
            </p>
          </>
        ) : (
          <p className="hint">Loading…</p>
        )}
        <button className="ghost" onClick={() => void fireBurst()}>
          Fire 3 requests at once
        </button>
        {burst && <p className="mono small">{burst}</p>}
      </aside>
    </div>
  );
}
