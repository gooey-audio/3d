// Types and fetch helpers for the studio API (src/app/api).
import type { BuildSummary, CadError, CheckpointInfo, PartInfo, RenderJob, Upload } from "@/lib/store";
import type { Face } from "@/lib/selection";
import type { Resolved, Scene } from "@/lib/scene";
import type { Units } from "@/lib/units";

export type { BuildSummary, CadError, CheckpointInfo, Face, PartInfo, RenderJob, Upload, Resolved, Scene };

export type Checkpoint = { id: string; at: number; script: string | null; scene: unknown };

export type Report = {
  params: Record<string, unknown>;
  /** The script's units (`size` is in them); absent on reports from before units (mm). */
  units?: string;
  size?: [number, number, number];
  /** Always mm, whatever the script's units. */
  size_mm: [number, number, number];
  volume_mm3: number;
  pieces: number;
  genus: number;
  triangles: number;
  brep_faces: number;
  closed: boolean;
  printability?: { ok: boolean; fails: string[]; material: string };
};

export type PartData = {
  name: string;
  script: string;
  sha: string;
  scene: Scene;
  resolved: Resolved | { error: string };
  build: BuildSummary | null;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && typeof window !== "undefined") {
    window.location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText, data);
  return data as T;
}

const p = (part: string) => `/api/parts/${encodeURIComponent(part)}`;

export const api = {
  parts: () => call<PartInfo[]>("GET", "/api/parts"),
  createPart: (name: string, units?: Units) => call<{ name: string }>("POST", "/api/parts", { name, units }),
  deletePart: (part: string) => call<{ ok: boolean }>("DELETE", p(part)),
  part: (part: string) => call<PartData>("GET", p(part)),
  putScript: (part: string, source: string, base_sha: string | null) =>
    call<{ sha: string; build: BuildSummary }>("PUT", `${p(part)}/script`, { source, base_sha }),
  build: (part: string) => call<BuildSummary>("POST", `${p(part)}/build`),
  patchScene: (part: string, patch: unknown) =>
    call<{ scene: Scene; resolved: Resolved; build: BuildSummary | null }>("PATCH", `${p(part)}/scene`, patch),
  meshUrl: (part: string, v: number | string) => `${p(part)}/mesh?v=${v}`,
  faces: (part: string) => call<Face[]>("GET", `${p(part)}/faces`),
  history: (part: string) => call<CheckpointInfo[]>("GET", `${p(part)}/history`),
  checkpoint: (part: string, id: string) => call<Checkpoint>("GET", `${p(part)}/history?id=${encodeURIComponent(id)}`),
  saveCheckpoint: (part: string) => call<{ id: string }>("POST", `${p(part)}/history`),
  revert: (part: string, id: string) => call<{ ok: boolean; build: BuildSummary }>("POST", `${p(part)}/revert/${encodeURIComponent(id)}`),
  stlDownloadUrl: (part: string) => `${p(part)}/mesh?download`,
  stepUrl: (part: string) => `${p(part)}/step`,
  uploads: () => call<Upload[]>("GET", "/api/uploads"),
  deleteUpload: (sha: string) => call<{ ok: boolean }>("DELETE", `/api/uploads/${sha}`),
  renders: () => call<RenderJob[]>("GET", "/api/renders"),
  render: (id: string) => call<RenderJob>("GET", `/api/renders/${id}`),
  startRender: (req: unknown) => call<RenderJob>("POST", "/api/renders", req),
  deleteRender: (id: string) => call<{ ok: boolean }>("DELETE", `/api/renders/${id}`),
  imageUrl: (id: string) => `/api/renders/${id}/image`,
};

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
