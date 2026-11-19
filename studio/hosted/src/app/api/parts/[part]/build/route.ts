import { NextResponse } from "next/server";
import { partName, route, type PartCtx } from "@/lib/http";
import { buildPart } from "@/lib/parts";

export const maxDuration = 60;

export const POST = route(async (_req, ctx: PartCtx) => {
  const part = partName((await ctx.params).part);
  return NextResponse.json(await buildPart(part));
});
