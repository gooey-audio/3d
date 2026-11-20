import { NextResponse } from "next/server";
import { route } from "@/lib/http";
import * as store from "@/lib/store";

export const DELETE = route(async (_req, ctx: { params: Promise<{ sha: string }> }) => {
  await store.deleteUpload((await ctx.params).sha);
  return NextResponse.json({ ok: true });
});
