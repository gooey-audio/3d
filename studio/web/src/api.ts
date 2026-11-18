// Types and fetch helpers for the gooey-studio server (studio/server/src/api.rs).

export type CadError = { kind: string; message: string; line?: number | null; column?: number | null };

export type BuildSummary = {
  part: string;
  rev: number;
  ok: boolean;
  seconds: number;
  overrides: Record<string, unknown>;
  report?: {
    params: Record<string, unknown>;
    size_mm: [number, number, number];
    volume_mm3: number;
    pieces: number;
    genus: number;
    triangles: number;
    brep_faces: number;
    closed: boolean;
    printability: { ok: boolean; fails: string[]; material: string };
  };
  error?: CadError;
  info?: { defaultParams: Record<string, unknown>; paramRanges: Record<string, [number, number]> };
};

export type Scene = {
  schema: string;
  params?: Record<string, unknown>;
  material?: string | Record<string, unknown>;
  environment: { type: string; intensity?: number; rotation_deg?: number; path?: string };
  background: string;
  exposure: number;
  camera: { view: string | [number, number, number]; fov: number };
};

export type ResolvedMaterial = {
  finish?: string;
  label?: string;
  color: [number, number, number];
  roughness: number;
  metalness: number;
  clearcoat: number;
  clearcoat_roughness: number;
  transmission: number;
  ior: number;
  opacity: number;
  sheen: number;
};

export type Resolved = {
  material: ResolvedMaterial;
  environment: { type: string; intensity: number; rotation_deg: number; path: string | null };
  background: string;
  exposure: number;
  camera: { direction: [number, number, number]; fov: number };
  error?: string;
};

export type PartData = {
  name: string;
  script: string;
  sha: string;
  scene: Scene;
  resolved: Resolved;
  build: BuildSummary | null;
  good_rev: number | null;
  turn: string | null;
};

export type Finish = { name: string; label: string; material: ResolvedMaterial | null };

export type Info = {
  version: string;
  dir: string;
  library: string | null;
  agent: { model: string; base_url: string } | null;
};

export type ChatMessage = {
  role: string;
  content?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

export type StoredTurn = {
  id: string;
  user: string;
  messages: ChatMessage[];
  done: boolean;
  error?: string;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data as T;
}

const p = (part: string) => `/api/parts/${encodeURIComponent(part)}`;

export const api = {
  info: () => call<Info>("GET", "/api/info"),
  parts: () => call<{ name: string; build: { ok: boolean; rev: number } | null }[]>("GET", "/api/parts"),
  createPart: (name: string) => call<{ name: string }>("POST", "/api/parts", { name }),
  part: (part: string) => call<PartData>("GET", p(part)),
  putScript: (part: string, source: string, base_sha: string | null) =>
    call<{ sha: string; rev: number | null }>("PUT", `${p(part)}/script`, { source, base_sha }),
  rebuild: (part: string) => call<{ rev: number }>("POST", `${p(part)}/build`),
  patchScene: (part: string, patch: unknown) =>
    call<{ scene: Scene; resolved: Resolved; rev: number | null }>("PATCH", `${p(part)}/scene`, patch),
  library: () => call<{ path: string | null; finishes: Finish[] }>("GET", "/api/library"),
  chat: (part: string) => call<{ turns: StoredTurn[]; running: string | null }>("GET", `${p(part)}/chat`),
  send: (part: string, message: string) => call<{ turn: string }>("POST", `${p(part)}/chat`, { message }),
  stop: (part: string) => call<{ stopped: boolean }>("POST", `${p(part)}/chat/stop`),
  clearChat: (part: string) => call<{ ok: boolean }>("DELETE", `${p(part)}/chat`),
  revert: (part: string, turn: string) => call<{ ok: boolean }>("POST", `${p(part)}/revert/${turn}`),
  meshUrl: (part: string, rev: number) => `${p(part)}/mesh.stl?rev=${rev}`,
  stepUrl: (part: string) => `${p(part)}/export.step`,
};

/** Server-sent events; reconnects (EventSource does) and reports a resync. */
export function subscribe(onEvent: (e: any) => void): () => void {
  const es = new EventSource("/api/events");
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data));
    } catch {
      /* ignore */
    }
  };
  es.onopen = () => onEvent({ type: "resync" });
  return () => es.close();
}

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
