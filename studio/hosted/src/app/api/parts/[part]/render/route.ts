import { NextResponse } from "next/server";
import { partName, route, type PartCtx } from "@/lib/http";
import { startPartSheet } from "@/lib/renders";

export const maxDuration = 60;

/** A contact sheet of the part in its look (iso, front, side, top). */
export const POST = route(async (_req, ctx: PartCtx) => {
  const part = partName((await ctx.params).part);
  return NextResponse.json(await startPartSheet(part), { status: 201 });
});
