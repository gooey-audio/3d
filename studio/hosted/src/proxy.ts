// Password gate for every page and API route except the login page and its POST route.
// Fails closed: without STUDIO_PASSWORD nothing is served.
import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, validSession } from "@/lib/auth";

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const api = pathname.startsWith("/api/");
  const password = process.env.STUDIO_PASSWORD;
  if (!password) {
    const msg = "The studio is locked: STUDIO_PASSWORD is not set on the server.";
    return api ? NextResponse.json({ error: msg }, { status: 503 }) : new NextResponse(msg, { status: 503, headers: { "content-type": "text/plain" } });
  }
  if (pathname === "/login" || (pathname === "/api/login" && req.method === "POST")) return NextResponse.next();
  if (await validSession(req.cookies.get(COOKIE)?.value, password)) return NextResponse.next();
  if (api) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const url = new URL("/login", req.url);
  if (pathname + search !== "/") url.searchParams.set("next", pathname + search);
  return NextResponse.redirect(url);
}

export const config = {
  // Everything but Next's own assets (scripts, styles, HMR) and the favicon.
  matcher: ["/((?!_next/|__nextjs|favicon\\.ico$).*)"],
};
