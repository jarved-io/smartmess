import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ status: "ok", database: "connected" });
  } catch (e) {
    return Response.json({ status: "error", database: "unreachable" }, { status: 500 });
  }
}
