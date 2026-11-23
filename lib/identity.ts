import { cookies } from "next/headers";
import type { Plan } from "@/lib/config";

/**
 * Demo identity: an anonymous id in an httpOnly cookie. In a real app, return
 * your session's user id here. Key budgets on accounts, not IP addresses:
 * an IP is shared by an office and rotated by an attacker.
 */
export async function currentUser(): Promise<{ userId: string; plan: Plan }> {
  const jar = await cookies();
  let id = jar.get("demo_uid")?.value;
  if (!id || !/^[a-f0-9-]{36}$/.test(id)) {
    id = crypto.randomUUID();
    jar.set("demo_uid", id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 30 });
  }
  const plan: Plan = jar.get("demo_plan")?.value === "pro" ? "pro" : "free";
  return { userId: `user:${id}`, plan };
}
