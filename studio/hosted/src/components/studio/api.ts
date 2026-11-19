// Types and fetch helpers for the studio API (src/app/api).
import type { BuildSummary, CadError, PartInfo, RenderJob, Upload } from "@/lib/store";
import type { Resolved, Scene } from "@/lib/scene";

export type { BuildSummary, CadError, PartInfo, RenderJob, Upload, Resolved, Scene };

export type Report = {
  params: Record<string, unknown>;
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
  createPart: (name: string) => call<{ name: string }>("POST", "/api/parts", { name }),
  deletePart: (part: string) => call<{ ok: boolean }>("DELETE", p(part)),
  part: (part: string) => call<PartData>("GET", p(part)),
  putScript: (part: string, source: string, base_sha: string | null) =>
    call<{ sha: string; build: BuildSummary }>("PUT", `${p(part)}/script`, { source, base_sha }),
  build: (part: string) => call<BuildSummary>("POST", `${p(part)}/build`),
  patchScene: (part: string, patch: unknown) =>
    call<{ scene: Scene; resolved: Resolved; build: BuildSummary | null }>("PATCH", `${p(part)}/scene`, patch),
  renderPart: (part: string) => call<RenderJob>("POST", `${p(part)}/render`),
  meshUrl: (part: string, v: number | string) => `${p(part)}/mesh?v=${v}`,
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
