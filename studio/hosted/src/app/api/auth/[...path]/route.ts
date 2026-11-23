import { getAuth, invited } from "@/lib/auth";
import { fail, publicRoute } from "@/lib/http";

type AuthCtx = { params: Promise<{ path: string[] }> };

export const GET = publicRoute(async (req, ctx: AuthCtx) => {
  if ((await ctx.params).path.join("/") !== "get-session") throw fail(404, "Unknown auth route.");
  const auth = getAuth();
  if (!auth) throw fail(503, "Sign-in is temporarily unavailable.");
  return auth.handler().GET(req, ctx);
});

export const POST = publicRoute(async (req, ctx: AuthCtx) => {
  const path = (await ctx.params).path.join("/");
  const auth = getAuth();
  if (!auth) throw fail(503, "Sign-in is temporarily unavailable.");
  if (path === "sign-out") return auth.handler().POST(req, ctx);
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
