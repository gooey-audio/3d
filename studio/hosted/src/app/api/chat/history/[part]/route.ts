// GET /api/chat/history/<part>: the stored conversation (UIMessage[]).
// DELETE /api/chat/history/<part>: clears it (checkpoints stay).
import * as store from "@/lib/store";

type Ctx = { params: Promise<{ part: string }> };

async function partOf(ctx: Ctx): Promise<string | Response> {
  const { part } = await ctx.params;
  return store.validPart(part) ? part : Response.json({ error: "bad part name" }, { status: 400 });
}

export async function GET(_req: Request, ctx: Ctx) {
  const part = await partOf(ctx);
  if (part instanceof Response) return part;
  return Response.json({ messages: await store.readChat(part) }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const part = await partOf(ctx);
  if (part instanceof Response) return part;
  await store.writeChat(part, []);
  return Response.json({ ok: true });
}
