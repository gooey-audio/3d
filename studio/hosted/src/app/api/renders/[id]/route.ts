import { NextResponse } from "next/server";
import { fail, noStore, route } from "@/lib/http";
import { refresh } from "@/lib/renders";
import * as store from "@/lib/store";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const job = await store.readJob(id);
  if (!job) throw fail(404, `no render ${id}`);
  return NextResponse.json(await refresh(job), { headers: noStore });
});

export const DELETE = route(async (_req, ctx: Ctx) => {
  await store.deleteJob((await ctx.params).id);
  return NextResponse.json({ ok: true });
});
