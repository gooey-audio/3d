// Part operations shared by the API routes and the agent's tools. Server-only.
import "server-only";
import * as modal from "./modal";
import { patchScene, type Scene } from "./scene";
import * as store from "./store";
import type { BuildSummary } from "./store";

/** Builds the part's current script with its scene's parameter overrides, on Modal, and
 *  stores the summary (and the mesh when it succeeds). The last good mesh is kept on failure. */
export async function buildPart(part: string): Promise<BuildSummary> {
  const [script, scene, prev] = await Promise.all([store.readScript(part), store.readScene(part), store.readBuild(part)]);
  if (script === null) throw new store.StoreError(`no part \`${part}\``);
  const overrides = scene.params ?? {};
  const res = await modal.build(script, overrides, { filename: `${part}.js` });
  let report: Record<string, unknown> | undefined;
  if (res.report) {
    const { faces: _faces, ...rest } = res.report as Record<string, unknown>;
    report = rest;
  }
  const summary: BuildSummary = {
    rev: (prev?.rev ?? 0) + 1,
    ok: res.ok,
    seconds: res.seconds,
    script_sha256: store.sha256(script),
    overrides,
    report,
    error: res.error,
    info: res.info ?? prev?.info ?? null,
    at: Date.now(),
  };
  if (res.ok && res.stl_b64) await store.writeMesh(part, Buffer.from(res.stl_b64, "base64"));
  await store.writeBuild(part, summary);
  return summary;
}

/** Writes the script, then builds it. */
export async function saveAndBuild(part: string, source: string): Promise<BuildSummary> {
  await store.writeScript(part, source);
  return buildPart(part);
}

/** Applies a merge patch to the scene; rebuilds when the parameters changed. */
export async function updateScene(part: string, patch: unknown): Promise<{ scene: Scene; build: BuildSummary | null }> {
  const cur = await store.readScene(part);
  const next = patchScene(cur, patch);
  await store.writeScene(part, next);
  const changed = JSON.stringify(cur.params ?? {}) !== JSON.stringify(next.params ?? {});
  return { scene: next, build: changed ? await buildPart(part) : null };
}

/** A compact build result for the agent: key numbers, or the error with its source lines. */
export function describeBuild(b: BuildSummary, script?: string): Record<string, unknown> {
  if (b.ok && b.report) {
    const r = b.report as any;
    return {
      ok: true,
      rev: b.rev,
      size_mm: r.size_mm,
      volume_mm3: r.volume_mm3,
      pieces: r.pieces,
      genus: r.genus,
      triangles: r.triangles,
      printability: { ok: r.printability?.ok, fails: r.printability?.fails },
      params: r.params,
      seconds: b.seconds,
    };
  }
  const out: Record<string, unknown> = { ok: false, rev: b.rev, error: b.error, seconds: b.seconds };
  const line = b.error?.line;
  if (line && script) {
    const lines = script.split("\n");
    out.source_context = lines
      .slice(Math.max(0, line - 4), line + 3)
      .map((l, i) => {
        const n = Math.max(0, line - 4) + i + 1;
        return `${n === line ? ">" : " "}${String(n).padStart(4)}| ${l}`;
      })
      .join("\n");
  }
  return out;
}
