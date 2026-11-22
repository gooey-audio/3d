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
  /** `units`: the script's (lengths in the params are in them); absent before units existed. */
  info?: { defaultParams: Record<string, unknown>; paramRanges: Record<string, [number, number]>; units?: string } | null;
  at: number;
  /** On a failed build: the last good build (whose mesh and faces are still stored). */
  lastGood?: { rev: number; at: number; report?: Record<string, unknown> } | null;
};

/** A script checkpoint under `parts/<part>/history/<id>.json` (id = ms timestamp). */
export type CheckpointInfo = { id: string; at: number; bytes: number };

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
  /** Who asked: the Renders page, the agent's render_sheet, or its look_at_part preview. */
  source?: RenderSource;
};

export type RenderSource = "studio" | "agent" | "preview";

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

/** The part's checkpoints, newest first. */
export async function listCheckpoints(part: string): Promise<CheckpointInfo[]> {
  const blobs = await listAll(partKey(part, "history/"));
  const out: CheckpointInfo[] = [];
  for (const b of blobs) {
    const m = /\/history\/(\d+)\.json$/.exec(b.pathname);
    if (m) out.push({ id: m[1], at: Number(m[1]), bytes: b.size });
  }
  return out.sort((a, b) => b.at - a.at);
}

export async function readCheckpoint(part: string, id: string): Promise<{ script: string | null; scene: unknown } | null> {
  if (!/^\d+$/.test(id)) throw new StoreError("bad checkpoint id");
  return readJson<{ script: string | null; scene: unknown }>(partKey(part, `history/${id}.json`));
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

/** The last good build's B-rep face table (`report.faces`): triangle ranges of mesh.stl. */
export async function readFaces(part: string): Promise<import("./selection").Face[]> {
  return (await readJson<import("./selection").Face[]>(partKey(part, "faces.json"))) ?? [];
}

export async function writeFaces(part: string, faces: import("./selection").Face[]): Promise<void> {
  await writeJson(partKey(part, "faces.json"), faces);
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

/** The agent turn holding the part (`parts/<part>/turn.json`); a best-effort lock. */
export type TurnLock = { id: string; model: string; started_ms: number; expires_ms: number };

export async function readTurn(part: string): Promise<TurnLock | null> {
  return readJson<TurnLock>(partKey(part, "turn.json")).catch(() => null);
}

export async function writeTurn(part: string, t: TurnLock): Promise<void> {
  await write(partKey(part, "turn.json"), JSON.stringify(t), "application/json");
}

export async function deleteTurn(part: string): Promise<void> {
  await del(partKey(part, "turn.json")).catch(() => {});
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

// --- streaming reads and listings for the HTTP routes ----------------------------

export type BlobStream = { stream: ReadableStream<Uint8Array>; size: number; contentType: string };

async function open(path: string): Promise<BlobStream | null> {
  const r = await get(path, { access: "private", useCache: false }).catch(() => null);
  if (!r || r.statusCode !== 200 || !r.stream) return null;
  return { stream: r.stream, size: r.blob.size, contentType: r.blob.contentType };
}

/** The last good mesh as a stream (large meshes are not buffered in the function). */
export async function openMesh(part: string): Promise<BlobStream | null> {
  return open(partKey(part, "mesh.stl"));
}

/** The stored conversation as a stream (streamed responses are not capped at 4.5 MB). */
export async function openChat(part: string): Promise<BlobStream | null> {
  return open(partKey(part, "chat.json"));
}

export async function openJobImage(id: string): Promise<BlobStream | null> {
  if (!validJob(id)) throw new StoreError("bad render id");
  return open(key(`renders/${id}.png`));
}

export type PartInfo = { name: string; mesh: boolean; updated_ms: number };

/** Parts with whether they have a mesh, from one listing. */
export async function listPartsInfo(): Promise<PartInfo[]> {
  const blobs = await listAll(key("parts/"));
  const parts = new Map<string, PartInfo>();
  const files = new Map<string, Set<string>>();
  for (const b of blobs) {
    const m = /^3d-studio\/parts\/([^/]+)\/([^/]+)$/.exec(b.pathname);
    if (!m) continue;
    if (!files.has(m[1])) files.set(m[1], new Set());
    files.get(m[1])!.add(m[2]);
    const p = parts.get(m[1]) ?? { name: m[1], mesh: false, updated_ms: 0 };
    p.updated_ms = Math.max(p.updated_ms, new Date(b.uploadedAt).getTime());
    parts.set(m[1], p);
  }
  return [...parts.values()]
    .filter((p) => files.get(p.name)!.has("script.js"))
    .map((p) => ({ ...p, mesh: files.get(p.name)!.has("mesh.stl") }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Where browsers upload large STLs directly (presigned); `adoptIncoming` then files them. */
export const INCOMING = "3d-studio/uploads/incoming/";

export function validIncoming(pathname: string): boolean {
  return /^3d-studio\/uploads\/incoming\/[A-Za-z0-9_-]{8,64}\.stl$/.test(pathname);
}

/** Moves a directly uploaded STL to `uploads/<sha256>.stl` with its metadata. */
export async function adoptIncoming(pathname: string, name: string): Promise<Upload> {
  if (!validIncoming(pathname)) throw new StoreError("bad upload path");
  const bytes = await readBytes(pathname);
  if (!bytes) throw new StoreError("the upload did not arrive");
  try {
    return await saveUpload(name, bytes);
  } finally {
    await del(pathname).catch(() => {});
  }
}
