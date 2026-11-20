import { NextResponse } from "next/server";
import { z } from "zod";
import { body, noStore, route } from "@/lib/http";
import { refresh, startRender, type RenderOptions } from "@/lib/renders";
import { parseHex, resolveMaterial, viewDirection } from "@/lib/scene";
import * as store from "@/lib/store";

export const maxDuration = 60;

const View = z.union([z.string().max(40), z.tuple([z.number(), z.number(), z.number()])]);
const Material = z.union([z.string().max(200), z.record(z.string(), z.unknown())]);
const Input = z.union([z.object({ part: z.string().max(100) }), z.object({ upload: z.string().regex(/^[0-9a-f]{64}$/) })]);
const Look = {
  spp: z.number().int().min(1).max(8192).optional(),
  background: z.string().max(20).optional(),
  environment: z.record(z.string(), z.unknown()).optional(),
  exposure: z.number().gt(0).max(16).optional(),
  fov: z.number().min(5).max(120).optional(),
};
const Sheet = z.object({
  kind: z.literal("sheet"),
  inputs: z.array(Input).min(1).max(50),
  views: z.array(View).max(36).optional(),
  orbit: z.string().regex(/^\d{1,2}(@-?\d{1,2}(\.\d+)?)?$/).nullable().optional(),
  materials: z.array(Material).max(40).optional(),
  tile: z.number().int().min(64).max(1200).optional(),
  label_from: z.enum(["name", "id"]).optional(),
  ...Look,
});
const Still = z.object({
  kind: z.literal("still"),
  input: Input,
  view: View.optional(),
  material: Material.optional(),
  width: z.number().int().min(64).max(4096).optional(),
  aspect: z.number().min(0.2).max(5).optional(),
  ...Look,
});
const Request = z.discriminatedUnion("kind", [Sheet, Still]);

export const GET = route(async () => {
  const jobs = await store.listJobs();
  const out = await Promise.all(jobs.map((j) => (j.status === "pending" ? refresh(j).catch(() => j) : j)));
  return NextResponse.json(out, { headers: noStore });
});

/** Starts a sheet (`inputs` × `views` + orbit × `materials`) or a still of one input. */
export const POST = route(async (req) => {
  const r = await body(req, Request);
  // Look checks up front: a bad colour is a 422 here, not a failed GPU job later.
  for (const m of r.kind === "sheet" ? (r.materials ?? []) : r.material !== undefined ? [r.material] : []) resolveMaterial(m);
  for (const v of r.kind === "sheet" ? (r.views ?? []) : r.view !== undefined ? [r.view] : []) viewDirection(v);
  if (r.background && r.background !== "transparent") parseHex(r.background);
  const look = { spp: r.spp, background: r.background, environment: r.environment, exposure: r.exposure, fov: r.fov };
  const o: RenderOptions =
    r.kind === "sheet"
      ? { kind: "sheet", inputs: r.inputs, views: r.views, orbit: r.orbit ?? null, materials: r.materials, tile: r.tile, label_from: r.label_from, ...look }
      : {
          kind: "still",
          inputs: [r.input],
          views: r.view !== undefined ? [r.view] : undefined,
          materials: r.material !== undefined ? [r.material] : undefined,
          width: r.width ?? 1600,
          aspect: r.aspect ?? 1.5,
          ...look,
        };
  if (o.kind === "sheet" && !o.views?.length && !o.orbit) o.views = ["iso"];
  return NextResponse.json(await startRender(o), { status: 201 });
});
