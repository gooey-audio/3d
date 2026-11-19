// Client for the Modal API (CONTRACT.md). Server-only.
//
// Without MODAL_API_URL (local `next dev`), builds and renders run the checkout's
// `engine/target/release/gooey-3d` instead (GOOEY_3D overrides the path), so the app works
// offline on a dev machine. Renders then run synchronously and return a `local-*` call id.
import "server-only";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CadError } from "./store";

const run = promisify(execFile);

export type BuildResponse = {
  ok: boolean;
  report?: Record<string, unknown>;
  stl_b64?: string;
  step_b64?: string | null;
  error?: CadError;
  info?: { defaultParams: Record<string, unknown>; paramRanges: Record<string, [number, number]> } | null;
  seconds: number;
};

export type RenderRequest = {
  kind: "sheet" | "still";
  inputs: { name: string; stl_b64: string }[];
  views?: (string | [number, number, number])[];
  orbit?: string | null;
  materials?: unknown[];
  tile?: number;
  spp?: number;
  background?: string;
  environment?: unknown;
  exposure?: number;
  fov?: number;
  label_from?: "name" | "id";
  width?: number;
  aspect?: number;
  library?: unknown;
};

export type RenderStatus =
  | { status: "pending" }
  | { status: "done"; png_b64: string; index: unknown; seconds: number; adapter?: string }
  | { status: "failed"; error: string };

const remote = () => process.env.MODAL_API_URL?.replace(/\/$/, "");

async function call<T>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${remote()}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.STUDIO_MODAL_TOKEN ?? ""}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Modal ${method} ${route}: ${res.status} ${(await res.text()).slice(0, 500)}`);
  return (await res.json()) as T;
}

export async function build(script: string, params: Record<string, unknown>, opts: { filename?: string; step?: boolean } = {}): Promise<BuildResponse> {
  const req = { script, params, filename: opts.filename ?? "part.js", step: !!opts.step };
  return remote() ? call<BuildResponse>("POST", "/build", req) : localBuild(req);
}

export async function submitRender(req: RenderRequest): Promise<{ call_id: string }> {
  return remote() ? call("POST", "/render", req) : localRender(req);
}

export async function renderStatus(callId: string): Promise<RenderStatus> {
  if (callId.startsWith("local-")) return localResults.get(callId) ?? { status: "failed", error: "unknown local render" };
  return call<RenderStatus>("GET", `/render/${encodeURIComponent(callId)}`);
}

// --- local fallback ------------------------------------------------------------

function gooey3d(): string {
  return process.env.GOOEY_3D ?? path.resolve(process.cwd(), "../../engine/target/release/gooey-3d");
}

function setArgs(params: Record<string, unknown>): string[] {
  return Object.entries(params).flatMap(([k, v]) => ["--set", `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`]);
}

async function localBuild(req: { script: string; params: Record<string, unknown>; filename: string; step: boolean }): Promise<BuildResponse> {
  const t0 = Date.now();
  const dir = await mkdtemp(path.join(tmpdir(), "studio-build-"));
  try {
    const file = path.join(dir, path.basename(req.filename).replace(/[^A-Za-z0-9_.-]/g, "-") || "part.js");
    await writeFile(file, req.script);
    const out = path.join(dir, "out");
    const stem = path.basename(file, ".js");
    let res: { ok: boolean; report?: Record<string, unknown>; error?: CadError };
    try {
      const { stdout } = await run(gooey3d(), ["cad", "build", file, "--out", out, "--json", ...setArgs(req.params)], { maxBuffer: 64 << 20 });
      res = JSON.parse(stdout);
    } catch (e: any) {
      res = e.stdout ? JSON.parse(e.stdout) : { ok: false, error: { kind: "worker", message: String(e.message) } };
    }
    let info: BuildResponse["info"] = null;
    try {
      const { stdout } = await run(gooey3d(), ["cad", "params", file, "--json"]);
      info = JSON.parse(stdout);
    } catch {
      /* the script does not load */
    }
    const seconds = (Date.now() - t0) / 1000;
    if (!res.ok) return { ok: false, error: res.error, info, seconds };
    const stl = await readFile(path.join(out, `${stem}.stl`));
    const step = req.step ? (await readFile(path.join(out, `${stem}.step`))).toString("base64") : null;
    return { ok: true, report: res.report, stl_b64: stl.toString("base64"), step_b64: step, info, seconds };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const localResults = new Map<string, RenderStatus>();

async function localRender(req: RenderRequest): Promise<{ call_id: string }> {
  const id = `local-${Date.now()}`;
  const t0 = Date.now();
  const dir = await mkdtemp(path.join(tmpdir(), "studio-render-"));
  try {
    const files: string[] = [];
    for (const [i, inp] of req.inputs.entries()) {
      const f = `${inp.name.replace(/[^A-Za-z0-9_.-]/g, "-") || `in${i}`}.stl`;
      await writeFile(path.join(dir, f), Buffer.from(inp.stl_b64, "base64"));
      files.push(f);
    }
    const a: string[] = [];
    const flag = (k: string, v: unknown) => v !== undefined && v !== null && a.push(k, typeof v === "string" ? v : JSON.stringify(v));
    const view = (v: unknown) => (Array.isArray(v) ? v.join(",") : String(v));
    const mat = (m: unknown) => (typeof m === "string" ? m : JSON.stringify(m));
    if (req.library) {
      await writeFile(path.join(dir, "library.json"), JSON.stringify(req.library));
      a.push("--library", "library.json");
    }
    flag("--spp", req.spp);
    flag("--background", req.background);
    flag("--env", req.environment);
    flag("--exposure", req.exposure);
    flag("--fov", req.fov);
    let out: string;
    if (req.kind === "sheet") {
      for (const v of req.views ?? []) a.push("--view", view(v));
      flag("--orbit", req.orbit);
      for (const m of req.materials ?? []) a.push("--material", mat(m));
      flag("--tile", req.tile);
      flag("--label-from", req.label_from);
      out = "sheet.png";
      await run(gooey3d(), ["render", "sheet", ...files, ...a, "--out", out, "--json"], { cwd: dir, maxBuffer: 64 << 20 });
    } else {
      if (req.views?.[0] !== undefined) a.push("--view", view(req.views[0]));
      if (req.materials?.[0] !== undefined) a.push("--material", mat(req.materials[0]));
      a.push("--width", String(req.width ?? 1600), "--aspect", String(req.aspect ?? 1.5));
      out = "still.png";
      await run(gooey3d(), ["render", "stl", files[0], ...a, "--out", out, "--json"], { cwd: dir, maxBuffer: 64 << 20 });
    }
    const png = await readFile(path.join(dir, out));
    const index = req.kind === "sheet" ? JSON.parse(await readFile(path.join(dir, "sheet.json"), "utf8")) : null;
    localResults.set(id, { status: "done", png_b64: png.toString("base64"), index, seconds: (Date.now() - t0) / 1000, adapter: "local" });
  } catch (e: any) {
    localResults.set(id, { status: "failed", error: String(e.stderr || e.message).slice(-2000) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { call_id: id };
}
