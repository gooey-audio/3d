// Part operations shared by the API routes and the agent's tools. Server-only.
import "server-only";
import * as modal from "./modal";
import { patchScene, type Scene } from "./scene";
import * as store from "./store";
import type { BuildSummary } from "./store";
import type { Face } from "./selection";
import { MM_PER_UNIT, reportUnits } from "./units";

/** Builds the part's current script with its scene's parameter overrides, on Modal, and
 *  stores the summary (and the mesh when it succeeds). The last good mesh is kept on failure. */
export async function buildPart(part: string): Promise<BuildSummary> {
  const [script, scene, prev] = await Promise.all([store.readScript(part), store.readScene(part), store.readBuild(part)]);
  if (script === null) throw new store.StoreError(`no part \`${part}\``);
  const overrides = scene.params ?? {};
  const res = await modal.build(script, overrides, { filename: `${part}.js` });
  let report: Record<string, unknown> | undefined;
  let faces: Face[] | undefined;
  if (res.report) {
    const { faces: f, ...rest } = res.report as Record<string, unknown>;
    report = rest;
    faces = (f as Face[] | undefined) ?? [];
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
  // A failed build keeps pointing at the last good one: its mesh, faces and report stay current.
  if (!res.ok && prev) summary.lastGood = prev.ok ? { rev: prev.rev, at: prev.at, report: prev.report } : (prev.lastGood ?? null);
  // Builds take a few seconds and may overlap (autosave, sliders, the agent): a result for a
  // script or parameters that changed meanwhile must not replace the newer build's mesh.
  const [nowScript, nowScene] = await Promise.all([store.readScript(part), store.readScene(part)]);
  const stale = nowScript !== script || JSON.stringify(nowScene.params ?? {}) !== JSON.stringify(overrides);
  if (stale) return summary;
  if (res.ok && res.stl_b64) {
    // The face table indexes the mesh's triangles, so the two are written together.
    await Promise.all([store.writeMesh(part, Buffer.from(res.stl_b64, "base64")), store.writeFaces(part, faces ?? [])]);
  }
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- report-v1 JSON, read loosely
    const r = b.report as any;
    // In the script's units: the numbers the model reads and writes.
    const units = reportUnits(r);
    const per = MM_PER_UNIT[units];
    const d = units === "mm" ? 2 : 4;
    return {
      ok: true,
      rev: b.rev,
      units,
      size: (r.size_mm as number[]).map((x) => +(x / per).toFixed(d)),
      volume: +(r.volume_mm3 / per ** 3).toPrecision(5),
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
