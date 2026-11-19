import { NextResponse } from "next/server";
import { z } from "zod";
import { body, fail, noStore, partName, route } from "@/lib/http";
import * as store from "@/lib/store";
import { TEMPLATE } from "@/lib/template";

export const GET = route(async () => NextResponse.json(await store.listPartsInfo(), { headers: noStore }));

const NewPart = z.object({ name: z.string(), source: z.string().max(1_000_000).optional() });

export const POST = route(async (req) => {
  const { name, source } = await body(req, NewPart);
  partName(name);
  if ((await store.readScript(name)) !== null) throw fail(409, `part \`${name}\` exists`);
  await store.writeScript(name, source ?? TEMPLATE);
  return NextResponse.json({ name }, { status: 201 });
});
