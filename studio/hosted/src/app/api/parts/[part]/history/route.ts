import { NextResponse } from "next/server";
import { fail, noStore, partName, route, type PartCtx } from "@/lib/http";
import * as store from "@/lib/store";

/** `GET`: the part's script checkpoints, newest first (`CheckpointInfo[]`).
 *  `GET ?id=<id>`: one checkpoint, `{ id, at, script, scene }`. */
export const GET = route(async (req, ctx: PartCtx) => {
  const part = partName((await ctx.params).part);
  const id = req.nextUrl.searchParams.get("id");
  if (id === null) return NextResponse.json(await store.listCheckpoints(part), { headers: noStore });
  const c = await store.readCheckpoint(part, id);
  if (!c) throw fail(404, `no checkpoint ${id}`);
  return NextResponse.json({ id, at: Number(id), ...c }, { headers: noStore });
});

/** Saves the current script and scene as a checkpoint (before restoring an older one). */
export const POST = route(async (_req, ctx: PartCtx) => {
  const part = partName((await ctx.params).part);
  if ((await store.readScript(part)) === null) throw fail(404, `no part \`${part}\``);
  return NextResponse.json({ id: await store.checkpoint(part) });
});
