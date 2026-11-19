import { NextResponse } from "next/server";
import { body, partName, route, type PartCtx } from "@/lib/http";
import { updateScene } from "@/lib/parts";
import { resolve } from "@/lib/scene";
import { z } from "zod";

export const maxDuration = 60;

/** A JSON merge patch on the scene; rebuilds when `params` changed. 422 on a bad scene. */
export const PATCH = route(async (req, ctx: PartCtx) => {
  const part = partName((await ctx.params).part);
  const patch = await body(req, z.record(z.string(), z.unknown()));
  const { scene, build } = await updateScene(part, patch);
  return NextResponse.json({ scene, resolved: resolve(scene), build });
});
