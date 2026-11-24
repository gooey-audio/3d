import { NextResponse } from "next/server";
import { getAuth, invited, requestOrigin } from "@/lib/auth";
import { fail, publicRoute } from "@/lib/http";

type AuthCtx = { params: Promise<{ path: string[] }> };

export const GET = publicRoute(async (req, ctx: AuthCtx) => {
  const path = (await ctx.params).path.join("/");
  const auth = getAuth();
  if (!auth) throw fail(503, "Sign-in is temporarily unavailable.");
  if (path === "get-session") return auth.handler().GET(req, ctx);
  if (path !== "google/callback") throw fail(404, "Unknown auth route.");

  const origin = requestOrigin(req.headers);
  if (!origin) throw fail(400, "Missing Studio origin.");
  const failure = new URL("/login?google=failed", origin);
  const verifier = req.nextUrl.searchParams.get("neon_auth_session_verifier");
  if (!verifier) return NextResponse.redirect(failure);

  // Exchange the verifier with Neon's challenge cookie, even if the browser already has a session.
  const url = new URL("/api/auth/get-session", origin);
  url.searchParams.set("neon_auth_session_verifier", verifier);
  url.searchParams.set("disableCookieCache", "true");
  const request = new Request(url, { headers: { origin, cookie: req.headers.get("cookie") ?? "" } });
  const exchange = await auth.handler().GET(request, { params: Promise.resolve({ path: ["get-session"] }) });
  const session = exchange.ok ? await exchange.json().catch(() => null) : null;
  if (!session?.session || !session?.user) return NextResponse.redirect(failure);

  const next = NextResponse.redirect(new URL("/", origin));
  for (const cookie of exchange.headers.getSetCookie()) next.headers.append("set-cookie", cookie);
  return next;
});

export const POST = publicRoute(async (req, ctx: AuthCtx) => {
  const path = (await ctx.params).path.join("/");
  const auth = getAuth();
  if (!auth) throw fail(503, "Sign-in is temporarily unavailable.");
  if (path === "sign-out") return auth.handler().POST(req, ctx);
  if (path === "sign-in/social") {
    const origin = requestOrigin(req.headers);
    if (!origin) throw fail(400, "Missing Studio origin.");
    const body = await req.json().catch(() => null);
    if (body?.provider !== "google") throw fail(400, "Google is the supported social provider.");
    const request = new Request(new URL("/api/auth/sign-in/social", origin), {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie: req.headers.get("cookie") ?? "" },
      body: JSON.stringify({
        provider: "google",
        callbackURL: new URL("/api/auth/google/callback", origin).href,
        errorCallbackURL: new URL("/login?google=failed", origin).href,
      }),
    });
    return auth.handler().POST(request, ctx);
  }
  if (path !== "email-otp/send-verification-otp" && path !== "sign-in/email-otp") {
    throw fail(404, "Unknown auth route.");
  }
  const body = await req.clone().json().catch(() => null);
  const allowed = typeof body?.email === "string" && invited(body.email);
  if (path === "email-otp/send-verification-otp") {
    if (body?.type !== "sign-in") throw fail(400, "Invalid sign-in request.");
    if (!allowed) return Response.json({ success: true });
  } else if (!allowed) {
    throw fail(400, "Invalid or expired code.");
  }
  return auth.handler().POST(req, ctx);
});
