// GET /api/chat/history/<part>: the stored conversation, `{ messages: UIMessage[] }`, streamed
// from Blob (a long chat may exceed the 4.5 MB cap on buffered function responses).
// DELETE /api/chat/history/<part>: clears it (checkpoints stay); 409 while a turn runs.
import { route } from "@/lib/http";
import * as lock from "@/lib/agent-lock";
import { modelLabel } from "@/lib/models";
import * as store from "@/lib/store";

type Ctx = { params: Promise<{ part: string }> };

async function partOf(ctx: Ctx): Promise<string | Response> {
  const { part } = await ctx.params;
  return store.validPart(part) ? part : Response.json({ error: "bad part name" }, { status: 400 });
}

export const GET = route(async (_req, ctx: Ctx) => {
  const part = await partOf(ctx);
  if (part instanceof Response) return part;
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  const chat = await store.openChat(part);
  if (!chat) return new Response(`{"messages":[]}`, { headers });
  // `{"messages":` + the stored array + `}`, without parsing it here.
  const enc = new TextEncoder();
  const body = chat.stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start: (c) => c.enqueue(enc.encode(`{"messages":`)),
      flush: (c) => c.enqueue(enc.encode("}")),
    }),
  );
  return new Response(body, { headers });
});

export const DELETE = route(async (_req, ctx: Ctx) => {
  const part = await partOf(ctx);
  if (part instanceof Response) return part;
  const t = await lock.holder(part);
  if (t) return Response.json(lock.lockedBody(t, modelLabel(t.model)), { status: 409 });
  await store.writeChat(part, []);
  return Response.json({ ok: true });
});
