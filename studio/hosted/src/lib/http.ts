// Helpers for the API route handlers. Server-only.
import "server-only";
import { connection, NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
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
  return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
}

/** Wraps a handler: request-time only (never prerendered) and errors mapped to JSON. */
export function route<C>(fn: (req: NextRequest, ctx: C) => Promise<Response>) {
  return async (req: NextRequest, ctx: C): Promise<Response> => {
    try {
      await connection();
      return await fn(req, ctx);
    } catch (e) {
      return errorResponse(e);
    }
  };
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
