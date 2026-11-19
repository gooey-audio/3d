// Persistence in the shared private Blob store `gooey`, confined to the `3d-studio/` prefix.
// Server-only. Layout: CONTRACT.md. Auth: BLOB_STORE_ID + VERCEL_OIDC_TOKEN (Vercel sets both;
// `vercel env pull` locally).
import "server-only";
import { del, get, list, put } from "@vercel/blob";
import { createHash } from "node:crypto";
import { defaultScene, normalize, type Scene } from "./scene";

const ROOT = "3d-studio/";

export type CadError = { kind: string; message: string; line?: number | null; column?: number | null };

/** What the UI and the agent see of a build (the report without its face table). */
export type BuildSummary = {
  rev: number;
  ok: boolean;
  seconds: number;
  script_sha256: string;
  overrides: Record<string, unknown>;
  report?: Record<string, unknown>;
  error?: CadError;
  info?: { defaultParams: Record<string, unknown>; paramRanges: Record<string, [number, number]> } | null;
  at: number;
};

export type Upload = { sha256: string; name: string; bytes: number; created_ms: number };

export type RenderJob = {
  id: string;
  kind: "sheet" | "still";
  status: "pending" | "done" | "failed";
  call_id?: string;
  created_ms: number;
  request: Record<string, unknown>;
  inputs: { name: string; part?: string; upload?: string }[];
  error?: string;
  seconds?: number;
  adapter?: string;
  index?: unknown;
};

export class StoreError extends Error {}

export function validPart(name: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(name);
}

function key(path: string): string {
  if (path.includes("..") || path.startsWith("/")) throw new StoreError(`bad path ${path}`);
  return ROOT + path;
}

function partKey(part: string, file: string): string {
  if (!validPart(part)) throw new StoreError(`bad part name \`${part}\``);
  return key(`parts/${part}/${file}`);
}

async function write(path: string, body: string | Buffer | Uint8Array, contentType: string) {
  await put(path, Buffer.isBuffer(body) || typeof body === "string" ? body : Buffer.from(body), {
    access: "private",
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType,
    cacheControlMaxAge: 60,
  });
}

async function readBytes(path: string): Promise<Buffer | null> {
  const r = await get(path, { access: "private", useCache: false }).catch(() => null);
  if (!r || !r.stream) return null;
  return Buffer.from(await new Response(r.stream).arrayBuffer());
}

async function readText(path: string): Promise<string | null> {
  const b = await readBytes(path);
  return b ? b.toString("utf8") : null;
}

async function readJson<T>(path: string): Promise<T | null> {
  const t = await readText(path);
  return t ? (JSON.parse(t) as T) : null;
}

async function writeJson(path: string, v: unknown) {
  await write(path, JSON.stringify(v, null, 2), "application/json");
}

async function listAll(prefix: string) {
  const out: { pathname: string; uploadedAt: Date; size: number }[] = [];
  let cursor: string | undefined;
  do {
    const r = await list({ prefix, cursor, limit: 1000 });
    out.push(...r.blobs);
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return out;
}

export const sha256 = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

// --- parts ---------------------------------------------------------------------

export async function listParts(): Promise<string[]> {
  const blobs = await listAll(key("parts/"));
  const names = new Set<string>();
  for (const b of blobs) {
    const m = /^3d-studio\/parts\/([^/]+)\/script\.js$/.exec(b.pathname);
    if (m) names.add(m[1]);
  }
  return [...names].sort();
}

export async function readScript(part: string): Promise<string | null> {
  return readText(partKey(part, "script.js"));
}

export async function writeScript(part: string, source: string): Promise<string> {
  await write(partKey(part, "script.js"), source, "text/javascript");
  return sha256(source);
}

export async function deletePart(part: string): Promise<void> {
  const blobs = await listAll(partKey(part, ""));
  if (blobs.length) await del(blobs.map((b) => b.pathname));
}

/** Saves the current script (and scene) under history/ and returns the checkpoint id. */
export async function checkpoint(part: string): Promise<string> {
  const id = String(Date.now());
  const [script, scene] = await Promise.all([readScript(part), readText(partKey(part, "scene.json"))]);
  await writeJson(partKey(part, `history/${id}.json`), { script, scene: scene ? JSON.parse(scene) : null });
  return id;
}

export async function restore(part: string, id: string): Promise<void> {
  if (!/^\d+$/.test(id)) throw new StoreError("bad checkpoint id");
  const c = await readJson<{ script: string | null; scene: unknown }>(partKey(part, `history/${id}.json`));
  if (!c) throw new StoreError(`no checkpoint ${id}`);
  if (c.script !== null) await writeScript(part, c.script);
  if (c.scene) await writeScene(part, normalize(c.scene));
  else await del(partKey(part, "scene.json")).catch(() => {});
}

export async function readScene(part: string): Promise<Scene> {
  const v = await readJson<unknown>(partKey(part, "scene.json"));
  return v ? normalize(v) : defaultScene();
}

export async function writeScene(part: string, s: Scene): Promise<void> {
  await writeJson(partKey(part, "scene.json"), s);
}

export async function readBuild(part: string): Promise<BuildSummary | null> {
  return readJson<BuildSummary>(partKey(part, "build.json"));
}

export async function writeBuild(part: string, b: BuildSummary): Promise<void> {
  await writeJson(partKey(part, "build.json"), b);
}

export async function readMesh(part: string): Promise<Buffer | null> {
  return readBytes(partKey(part, "mesh.stl"));
}

export async function writeMesh(part: string, stl: Uint8Array): Promise<void> {
  await write(partKey(part, "mesh.stl"), stl, "model/stl");
}

export async function readChat<T = unknown>(part: string): Promise<T[]> {
  return (await readJson<T[]>(partKey(part, "chat.json"))) ?? [];
}

export async function writeChat(part: string, messages: unknown[]): Promise<void> {
  await writeJson(partKey(part, "chat.json"), messages);
}

// --- uploads -------------------------------------------------------------------

export async function saveUpload(name: string, bytes: Uint8Array): Promise<Upload> {
  const h = sha256(bytes);
  const stem = name.replace(/\.stl$/i, "").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60) || "part";
  const u: Upload = { sha256: h, name: stem, bytes: bytes.length, created_ms: Date.now() };
  await write(key(`uploads/${h}.stl`), bytes, "model/stl");
  await writeJson(key(`uploads/${h}.json`), u);
  return u;
}

export async function listUploads(): Promise<Upload[]> {
  const blobs = (await listAll(key("uploads/"))).filter((b) => b.pathname.endsWith(".json"));
  const ups = await Promise.all(blobs.map((b) => readJson<Upload>(b.pathname)));
  return ups.filter((u): u is Upload => !!u).sort((a, b) => b.created_ms - a.created_ms);
}

export async function readUpload(h: string): Promise<{ meta: Upload; stl: Buffer } | null> {
  if (!/^[0-9a-f]{64}$/.test(h)) throw new StoreError("bad upload id");
  const [meta, stl] = await Promise.all([readJson<Upload>(key(`uploads/${h}.json`)), readBytes(key(`uploads/${h}.stl`))]);
  return meta && stl ? { meta, stl } : null;
}

export async function deleteUpload(h: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(h)) throw new StoreError("bad upload id");
  await del([key(`uploads/${h}.stl`), key(`uploads/${h}.json`)]);
}

// --- renders -------------------------------------------------------------------

const validJob = (id: string) => /^r\d+$/.test(id);

export async function writeJob(j: RenderJob): Promise<void> {
  if (!validJob(j.id)) throw new StoreError("bad render id");
  await writeJson(key(`renders/${j.id}.json`), j);
}

export async function readJob(id: string): Promise<RenderJob | null> {
  if (!validJob(id)) throw new StoreError("bad render id");
  return readJson<RenderJob>(key(`renders/${id}.json`));
}

export async function listJobs(): Promise<RenderJob[]> {
  const blobs = (await listAll(key("renders/"))).filter((b) => b.pathname.endsWith(".json"));
  const jobs = await Promise.all(blobs.map((b) => readJson<RenderJob>(b.pathname)));
  return jobs.filter((j): j is RenderJob => !!j).sort((a, b) => b.created_ms - a.created_ms);
}

export async function writeJobImage(id: string, png: Uint8Array): Promise<void> {
  if (!validJob(id)) throw new StoreError("bad render id");
  await write(key(`renders/${id}.png`), png, "image/png");
}

export async function readJobImage(id: string): Promise<Buffer | null> {
  if (!validJob(id)) throw new StoreError("bad render id");
  return readBytes(key(`renders/${id}.png`));
}

export async function deleteJob(id: string): Promise<void> {
  if (!validJob(id)) throw new StoreError("bad render id");
  await del([key(`renders/${id}.json`), key(`renders/${id}.png`)]).catch(() => {});
}
