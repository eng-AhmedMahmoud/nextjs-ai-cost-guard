import { cookies } from "next/headers";
import { usageSnapshot } from "@/lib/guard";
import { currentUser } from "@/lib/identity";
import { usingMock } from "@/lib/model";

export const dynamic = "force-dynamic";

export async function GET() {
  const { userId, plan } = await currentUser();
  const snapshot = await usageSnapshot(userId, plan);
  return Response.json({ ...snapshot, mockModel: usingMock }, { headers: { "Cache-Control": "no-store" } });
}

/** Demo only: switch between the free and pro plans. */
export async function POST(req: Request) {
  const { plan } = (await req.json()) as { plan?: string };
  (await cookies()).set("demo_plan", plan === "pro" ? "pro" : "free", { httpOnly: true, sameSite: "lax", path: "/" });
  return Response.json({ ok: true });
}
