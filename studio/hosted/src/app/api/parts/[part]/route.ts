import { NextResponse } from "next/server";
import { fail, noStore, partName, route, type PartCtx } from "@/lib/http";
import { resolve } from "@/lib/scene";
import * as store from "@/lib/store";

export const GET = route(async (_req, ctx: PartCtx) => {
  const part = partName((await ctx.params).part);
  const [script, scene, build] = await Promise.all([store.readScript(part), store.readScene(part), store.readBuild(part)]);
  if (script === null) throw fail(404, `no part \`${part}\``);
  let resolved: unknown;
  try {
    resolved = resolve(scene);
  } catch (e) {
    resolved = { error: e instanceof Error ? e.message : String(e) };
  }
  return NextResponse.json({ name: part, script, sha: store.sha256(script), scene, resolved, build }, { headers: noStore });
});

export const DELETE = route(async (_req, ctx: PartCtx) => {
  const part = partName((await ctx.params).part);
  await store.deletePart(part);
  return NextResponse.json({ ok: true });
});
