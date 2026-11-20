// Render jobs: submit to Modal, poll, and store the result in Blob. Server-only.
import "server-only";
import * as modal from "./modal";
import { LIBRARY, renderLook, type MaterialSpec } from "./scene";
import * as store from "./store";
import type { RenderJob } from "./store";

export type RenderInput = { part: string } | { upload: string };

export type RenderOptions = {
  kind: "sheet" | "still";
  inputs: RenderInput[];
  views?: (string | [number, number, number])[];
  orbit?: string | null;
  materials?: MaterialSpec[];
  tile?: number;
  spp?: number;
  background?: string;
  environment?: unknown;
  exposure?: number;
  fov?: number;
  label_from?: "name" | "id";
  width?: number;
  aspect?: number;
};

/** At most this many tiles (inputs × views × materials) per sheet. */
export const MAX_TILES = 400;

export async function startRender(o: RenderOptions): Promise<RenderJob> {
  if (!o.inputs.length) throw new store.StoreError("a render needs at least one input");
  const orbitN = o.orbit ? parseInt(o.orbit, 10) || 0 : 0;
  const tiles = o.inputs.length * Math.max(1, (o.views?.length ?? 0) + orbitN) * Math.max(1, o.materials?.length ?? 0);
  if (o.kind === "sheet" && tiles > MAX_TILES) throw new store.StoreError(`${tiles} tiles; at most ${MAX_TILES} per sheet`);
  const inputs: { name: string; stl_b64: string }[] = [];
  const meta: RenderJob["inputs"] = [];
  const used = new Set<string>();
  for (const inp of o.inputs) {
    let name: string;
    let stl: Buffer | null;
    if ("part" in inp) {
      name = inp.part;
      stl = await store.readMesh(inp.part);
      if (!stl) throw new store.StoreError(`part \`${inp.part}\` has no good build yet`);
    } else {
      const u = await store.readUpload(inp.upload);
      if (!u) throw new store.StoreError(`no upload ${inp.upload}`);
      name = u.meta.name;
      stl = u.stl;
    }
    let unique = name;
    for (let n = 2; used.has(unique); n++) unique = `${name}-${n}`;
    used.add(unique);
    inputs.push({ name: unique, stl_b64: stl.toString("base64") });
    meta.push({ name: unique, ...inp });
  }
  const { inputs: _, ...rest } = o;
  const request = { ...rest, library: LIBRARY };
  const { call_id } = await modal.submitRender({ ...request, inputs });
  const job: RenderJob = { id: `r${Date.now()}`, kind: o.kind, status: "pending", call_id, created_ms: Date.now(), request: rest, inputs: meta };
  await store.writeJob(job);
  return job;
}

/** A sheet of a part in its scene's look (the editor's "Render" button and the agent's tool). */
export async function startPartSheet(part: string, o: { views?: RenderOptions["views"]; orbit?: string | null; spp?: number } = {}) {
  const scene = await store.readScene(part);
  const views = o.views?.length || o.orbit ? o.views ?? [] : ["iso", "front", "side", "top"];
  return startRender({ kind: "sheet", inputs: [{ part }], views, orbit: o.orbit ?? null, tile: 480, spp: o.spp ?? 256, ...renderLook(scene) });
}

/** Polls Modal for a pending job and stores its result. Returns the (possibly updated) job. */
export async function refresh(job: RenderJob): Promise<RenderJob> {
  if (job.status !== "pending" || !job.call_id) return job;
  const s = await modal.renderStatus(job.call_id);
  if (s.status === "pending") return job;
  const next: RenderJob = { ...job };
  if (s.status === "done") {
    await store.writeJobImage(job.id, Buffer.from(s.png_b64, "base64"));
    Object.assign(next, { status: "done", index: s.index, seconds: s.seconds, adapter: s.adapter });
  } else {
    Object.assign(next, { status: "failed", error: s.error });
  }
  await store.writeJob(next);
  return next;
}
