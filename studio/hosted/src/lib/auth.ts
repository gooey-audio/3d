import "server-only";
import { createNeonAuth } from "@neon/auth/next/server";
import { headers } from "next/headers";

let auth: ReturnType<typeof createNeonAuth> | undefined;

export function getAuth() {
  const baseUrl = process.env.NEON_AUTH_BASE_URL?.trim();
  const secret = process.env.NEON_AUTH_COOKIE_SECRET?.trim();
  if (!baseUrl || !secret || secret.length < 32) return null;
  return auth ??= createNeonAuth({ baseUrl: baseUrl.replace(/\/+$/, ""), cookies: { secret } });
}

export function invited(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return !!normalized && (process.env.STUDIO_INVITED_EMAILS ?? "").split(",")
    .some((value) => value.trim().toLowerCase() === normalized);
}

export function requestOrigin(incoming: Pick<Headers, "get">): string | undefined {
  const host = incoming.get("x-forwarded-host") ?? incoming.get("host");
  const scheme = incoming.get("x-forwarded-proto") === "https" ? "https" : "http";
  if (host) return new URL(`${scheme}://${host}`).origin;
}

type Auth = NonNullable<ReturnType<typeof getAuth>>;
type SessionResult = Awaited<ReturnType<Auth["getSession"]>>;

// Server Components can read the session but cannot apply a rotated or expired cookie.
// Use the SDK's proxy handler there so that Set-Cookie stays on its response.
async function readPageSession(auth: Auth): Promise<SessionResult["data"] | undefined> {
  const incoming = await headers();
  const origin = requestOrigin(incoming);
  if (!origin) return undefined;
  const url = new URL("/api/auth/get-session", origin);
  const request = new Request(url, { headers: { origin, cookie: incoming.get("cookie") ?? "" } });
  const response = await auth.handler().GET(request, { params: Promise.resolve({ path: ["get-session"] }) });
  if (response.status === 401) return null;
  if (!response.ok) return undefined;
  return response.json();
}

export async function studioAccount({ page = false } = {}) {
  const auth = getAuth();
  if (!auth) return { status: "unavailable" } as const;
  const data = page ? await readPageSession(auth) : await auth.getSession().then(({ data, error }) => {
    return error && error.status !== 401 ? undefined : data;
  });
  if (data === undefined) return { status: "unavailable" } as const;
  if (!data?.user?.id || !(Date.parse(String(data.session?.expiresAt)) > Date.now())) {
    return { status: "signed-out" } as const;
  }
  if (!data.user.emailVerified || !invited(data.user.email)) return { status: "denied" } as const;
  return { status: "ok", user: data.user } as const;
}
