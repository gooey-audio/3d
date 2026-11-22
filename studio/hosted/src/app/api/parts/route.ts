import { NextResponse } from "next/server";
import { z } from "zod";
import { body, fail, noStore, partName, route } from "@/lib/http";
import * as store from "@/lib/store";
import { template } from "@/lib/template";
import { UNITS } from "@/lib/units";

export const GET = route(async () => NextResponse.json(await store.listPartsInfo(), { headers: noStore }));

const NewPart = z.object({ name: z.string(), source: z.string().max(1_000_000).optional(), units: z.enum(UNITS).optional() });

export const POST = route(async (req) => {
  const { name, source, units } = await body(req, NewPart);
  partName(name);
  if ((await store.readScript(name)) !== null) throw fail(409, `part \`${name}\` exists`);
  await store.writeScript(name, source ?? template(units));
  return NextResponse.json({ name }, { status: 201 });
});
