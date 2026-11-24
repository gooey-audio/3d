// Helpers for the API route handlers. Server-only.
import "server-only";
import { connection, NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requestOrigin, studioAccount } from "./auth";
import { inWorkspace } from "./workspace";
import { SceneError } from "./scene";
import { StoreError, validPart } from "./store";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const fail = (status: number, message: string, extra?: Record<string, unknown>) => new HttpError(status, message, extra);

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return NextResponse.json({ error: e.message, ...e.extra }, { status: e.status });
  if (e instanceof SceneError) return NextResponse.json({ error: e.message }, { status: 422 });
  if (e instanceof StoreError) return NextResponse.json({ error: e.message }, { status: /^no /.test(e.message) ? 404 : 400 });
  if (e instanceof z.ZodError) {
    const i = e.issues[0];
    return NextResponse.json({ error: `${i.path.join(".") || "body"}: ${i.message}` }, { status: 400 });
  }
  console.error(e);
  return NextResponse.json({ error: "The studio could not complete the request." }, { status: 500 });
}

type Handler<C> = (req: NextRequest, ctx: C) => Promise<Response>;

/** Runs at request time and gives every response (including errors) private cache semantics. */
export function publicRoute<C>(fn: Handler<C>) {
  return async (req: NextRequest, ctx: C): Promise<Response> => {
    await connection();
    let response: Response;
    try {
      const origin = req.headers.get("origin");
      if (req.method !== "GET" && req.method !== "HEAD" && origin && origin !== requestOrigin(req.headers)) {
        throw fail(403, "Cross-origin request.");
      }
      response = await fn(req, ctx);
    } catch (e) {
      response = errorResponse(e);
    }
    response.headers.set("cache-control", "private, no-store");
    return response;
  };
}

export function route<C>(fn: (req: NextRequest, ctx: C, accountId: string) => Promise<Response>) {
  return publicRoute(async (req, ctx: C) => {
    const account = await studioAccount();
    if (account.status === "unavailable") throw fail(503, "Sign-in is temporarily unavailable.");
    if (account.status === "denied") throw fail(403, "This account does not have beta access.");
    if (account.status !== "ok") throw fail(401, "Sign in to use the studio.");
    return inWorkspace(account.user.id, () => fn(req, ctx, account.user.id));
  });
}

export async function body<T>(req: NextRequest, schema: z.ZodType<T>): Promise<T> {
  let v: unknown;
  try {
    v = await req.json();
  } catch {
    throw fail(400, "the body must be JSON");
  }
  return schema.parse(v);
}

export function partName(p: string): string {
  if (!validPart(p)) throw fail(400, `bad part name \`${p}\` (letters, digits, - _ and .)`);
  return p;
}

export type PartCtx = { params: Promise<{ part: string }> };

export const noStore = { "cache-control": "no-store" };
