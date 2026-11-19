import { NextResponse } from "next/server";
import { z } from "zod";
import { body, fail, partName, route, type PartCtx } from "@/lib/http";
import { saveAndBuild } from "@/lib/parts";
import * as store from "@/lib/store";

export const maxDuration = 60;

const PutScript = z.object({ source: z.string().max(1_000_000), base_sha: z.string().nullable().optional() });

/** Saves the script (unless someone else changed it since `base_sha`) and builds it. */
export const PUT = route(async (req, ctx: PartCtx) => {
  const part = partName((await ctx.params).part);
  const { source, base_sha } = await body(req, PutScript);
  const cur = await store.readScript(part);
  if (cur === null) throw fail(404, `no part \`${part}\``);
  const sha = store.sha256(cur);
  if (base_sha && base_sha !== sha) throw fail(409, "the script changed since you loaded it", { sha });
  const build = await saveAndBuild(part, source);
  return NextResponse.json({ sha: store.sha256(source), build });
});
