import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Cost Guard",
  description: "Rate limits, token budgets, stream slots and a spend circuit breaker for a Next.js AI chat, on Upstash Redis.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
