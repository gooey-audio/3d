// The temporary password gate. The session cookie holds HMAC-SHA256("gooey-studio session v1")
// keyed by STUDIO_PASSWORD, so changing the password signs everyone out. Web Crypto only: used
// by the proxy and the login route.

export const COOKIE = "studio_session";
const MESSAGE = "gooey-studio session v1";

const enc = new TextEncoder();

export async function sessionToken(password: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(MESSAGE)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function validSession(cookie: string | undefined, password: string): Promise<boolean> {
  return !!cookie && safeEqual(cookie, await sessionToken(password));
}
