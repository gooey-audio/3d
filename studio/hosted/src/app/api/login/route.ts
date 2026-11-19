import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, safeEqual, sessionToken } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const password = process.env.STUDIO_PASSWORD;
  if (!password) return NextResponse.json({ error: "STUDIO_PASSWORD is not set" }, { status: 503 });
  const body = (await req.json().catch(() => null)) as { password?: unknown } | null;
  const given = typeof body?.password === "string" ? body.password : "";
  const [want, got] = await Promise.all([sessionToken(password), sessionToken(given)]);
  if (!safeEqual(want, got)) {
    await new Promise((r) => setTimeout(r, 400)); // slow down guessing a little
    return NextResponse.json({ error: "wrong password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, want, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
