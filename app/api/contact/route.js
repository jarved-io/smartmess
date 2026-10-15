import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim();
  const message = String(body.message || "").trim();

  if (!name || !email || !message) {
    return Response.json({ error: "All fields are required" }, { status: 400 });
  }
  if (!emailRe.test(email)) {
    return Response.json({ error: "Invalid email address" }, { status: 400 });
  }
  if (name.length > 100 || message.length > 2000) {
    return Response.json({ error: "Input too long" }, { status: 400 });
  }

  try {
    const saved = await prisma.contact.create({ data: { name, email, message } });
    return Response.json({ ok: true, id: saved.id }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "Server error" }, { status: 500 });
  }
}

// Read stored messages: GET /api/contact with header "x-admin-key: <ADMIN_KEY>"
export async function GET(request) {
  const key = request.headers.get("x-admin-key");
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const items = await prisma.contact.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  return Response.json(items);
}
