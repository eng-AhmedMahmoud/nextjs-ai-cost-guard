import { Chat } from "./chat";

export default function Page() {
  return (
    <main className="shell">
      <header className="top">
        <h1>AI Cost Guard</h1>
        <p>
          A streaming chat route behind four guards on Upstash Redis: a request rate limit, a daily token budget,
          per-user stream slots, and a global spend circuit breaker.
        </p>
      </header>
      <Chat />
    </main>
  );
}
