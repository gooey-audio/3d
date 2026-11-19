import { NextResponse } from "next/server";
import { partName, route } from "@/lib/http";
import { buildPart } from "@/lib/parts";
import * as store from "@/lib/store";

export const maxDuration = 60;

/** Restores the script and scene saved at a checkpoint (before an agent turn) and rebuilds. */
export const POST = route(async (_req, ctx: { params: Promise<{ part: string; checkpoint: string }> }) => {
  const { part: p, checkpoint } = await ctx.params;
  const part = partName(p);
  await store.restore(part, checkpoint);
  return NextResponse.json({ ok: true, build: await buildPart(part) });
});
