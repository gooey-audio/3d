import { NextResponse } from "next/server";
import { noStore, partName, route, type PartCtx } from "@/lib/http";
import * as store from "@/lib/store";

/** The last good mesh's B-rep face table (written with mesh.stl): `Face[]`, `[]` if none. */
export const GET = route(async (_req, ctx: PartCtx) => {
  const part = partName((await ctx.params).part);
  return NextResponse.json(await store.readFaces(part), { headers: noStore });
});
