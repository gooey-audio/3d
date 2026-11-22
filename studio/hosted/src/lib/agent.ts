// The embedded CAD agent: system prompt, per-turn context and tools over the shared part
// libraries. A port of studio/server/src/agent.rs. Server-only.
import "server-only";
import { tool, type JSONValue, type ToolResultPart, type ToolSet } from "ai";
import { z } from "zod";
import { unifiedDiff } from "./agent-diff";
import { surfaceLabel, type LookResult, type ScriptDiff } from "./agent-shared";
import { buildPart, describeBuild, saveAndBuild, updateScene } from "./parts";
import { refresh, startPartSheet, startRender } from "./renders";
import { CAD_SKILL } from "./prompts/cad-skill";
import { REPLICAD_IDIOMS } from "./prompts/replicad-idioms";
import { FINISHES, renderLook, resolve, SceneError } from "./scene";
import { describeSelection, type Face, type FaceSelection } from "./selection";
import * as store from "./store";
import { fromMm, partUnits, toMm, UNIT_LABELS, type Units } from "./units";

type ToolResultOutput = ToolResultPart["output"];

export function numbered(src: string): string {
  return src
    .split("\n")
    .map((l, i) => `${String(i + 1).padStart(4)}| ${l}`)
    .join("\n");
}

export function systemPrompt(part: string, opts: { vision?: boolean } = {}): string {
  const finishes = FINISHES.length ? FINISHES.map((f) => f.name).join(", ") : "none loaded; use colours and look overrides";
  const look = opts.vision
    ? `- look_at_part renders the current build as a small path-traced sheet (iso, top and front by \
default) and shows it to you. Use it to check a visual change you are unsure of: a fillet that \
might not have gone where you meant, a feature's placement, a request about how the part looks. \
It takes 5–15 s, so do not call it after every edit. The numbers in the build result \
(size, genus, pieces, volume) are the first check.`
    : `- look_at_part renders a small sheet for the user. You cannot see images, so use the build \
numbers to check your work; only call it when the user wants to see the part.`;
  return `You are the CAD assistant inside gooey-studio, a live editor for one parametric part: \
\`${part}.js\`, a Replicad script. The user sees the script in an editor and the built part in a \
three.js preview. Both update as soon as you change anything.

How to work:
- Change the part by editing the program (edit_script for targeted changes, write_script for \
rewrites), never by describing a mesh. Keep the script's conventions: \`defaultParams\`, \
\`paramRanges\`, optional \`expect\`, and \`main(replicad, params)\` returning one solid. Expose \
meaningful dimensions as parameters.
- Every script or parameter change rebuilds and validates the part and returns the result. If a \
build fails, read the error kind, message and line, fix the cause, and try again. Do not stop on a \
failed build unless you explain why you cannot fix it.
- edit_script edits are exact text replacements: each old_text must occur exactly once in the \
current script. If an edit fails, nothing was changed; read the script and retry.
- Units: the script declares its length unit, \`export const units = "in"\` (or "cm" or "mm"), \
and every length in it is in that unit. The studio default is inches. Keep the declaration; never \
change it to rescale a part (that changes every number's meaning). Build results (\`size\`, \
\`volume\`), face centres, points and get_faces are all in the script's units. The turn's \
<studio-context> names the part's units and the units the user reads; give dimensions to the user \
in theirs (convert when they differ). Metric hardware stays metric: an M5 clearance hole in an \
inch part is \`5.5 / 25.4\`.
- The part frame is Z up (CAD convention); it is shown resting on a ground plane.
- Use set_params to change parameter values; use edit_script to change defaults, ranges or the \
geometry itself. Do not change the same value both ways in one step.
- Change the look with update_scene (a JSON merge patch over the scene document). The scene's \
\`material\` is a finish name from the library (${finishes}), a colour \`#rrggbb\`, or an object such \
as {"color": "#c0c4c8", "metalness": 1, "roughness": 0.25} or \
{"finish": "wood/walnut", "clearcoat": 0.5} (look keys: roughness, metalness, clearcoat, \
clearcoat_roughness, transmission, ior, opacity, sheen; all 0..1 except ior 1..3). \`environment\` \
is {"type": "studio", "intensity": 1, "rotation_deg": 0} (softbox key, fill and rim \
lights, turned about the vertical axis). \`background\` is \`#rrggbb\` or \`transparent\`; \`exposure\` > \
0; \`camera\` is {"view": "iso"|"front"|"side"|"top"|"rear"|"rear-iso"|[x,y,z], "fov": \
degrees} (Y up in view space).
${look}
- render_sheet queues a final, full-quality contact sheet for the user. Only use it when the user \
asks for a render.

Selected faces:
- The user can click faces in the viewer. Then the turn's <studio-context> has a "Selected \
faces" list, and words like "this face", "these", "here" or "the edges of this" refer to it. Each \
entry has the B-rep face number, its surface type (plane, cylinder, cone, sphere, torus, bspline, \
revolution, extrusion, ...), its centre and unit normal, and the clicked point. All are in part coordinates, the frame of the \
script (its units, Z up).
- Face numbers belong to one build and change when the topology changes. Never write them into \
the script. Target the geometry with finders built from the centre, normal and point:
  - planar face with normal ±Z at z = h: faces \`f.inPlane("XY", h)\`, its edges \`e.inPlane("XY", h)\`;
  - normal ±X at x = a: \`inPlane("YZ", a)\`; normal ±Y at y = b: \`inPlane("XZ", [0, b, 0])\` \
(see the "XZ" sign note below);
  - any face: \`f.near(centre, tol)\` (tol about 0.01 in, 0.03 cm, 0.3 mm) or \`f.containsPoint(point)\` (planar faces), \
\`f.ofSurfaceType("CYLINDRE")\` (scripts use Replicad's names: PLANE, CYLINDRE, CONE, SPHERE, \
TORUS, BSPLINE_SURFACE, ...), \`f.atAngleWith("Z", 0)\`; edges of a face: \`inList(face.edges)\` \
(below); edges near a point: \`e.near(point, tol)\`, \`e.atDistance(d, point)\`, \
\`e.withinDistance(d, point)\`; combine with \`either\`, \`not\` and chaining (AND).
- Write finder points in terms of the parameters (e.g. \`[halfL - p.inset, 0, p.height]\`), not as \
the literal numbers from the selection, so the finder still matches after a parameter changes.
- Before you change the geometry, check where the selected face sits in the script. If it is \
not the one the user means (e.g. one strip of a curved surface), say what you did.
- get_faces looks up the last good build's face table: filter by type, near a point or facing a \
direction. Use it to find a face's neighbours or to check which faces a finder should match.

When you finish:
- Reply in at most three short sentences (about 60 words), with no headings or bullet lists unless \
the user asked for detail. Say what changed and give the key numbers (size, genus or holes, \
pieces). Mention a caveat only if the user must act on it, e.g. a parameter that no longer \
applies. Do not repeat the code, list the tool calls, explain Replicad or restate warnings that \
were already there before your change.

${REPLICAD_IDIOMS}

Reference: the gooey-3d cad skill. Its CLI sections do not apply here; the tools replace them.

${CAD_SKILL}`;
}

/** The units of a part's script: its declaration, else what the last good build used. */
function unitsOf(build: store.BuildSummary | null, script: string | null): Units {
  const report = build?.ok ? build.report : build?.lastGood?.report;
  return partUnits(report as { units?: unknown } | undefined, script);
}

/** The fresh state of the part, prepended to the user's message for this turn. `display` is
 *  the units the user reads dimensions in (the studio setting). */
export async function context(part: string, selection?: FaceSelection[], display?: Units): Promise<string> {
  const [script, scene, build] = await Promise.all([store.readScript(part), store.readScene(part), store.readBuild(part)]);
  const b = build ? describeBuild(build, script ?? undefined) : null;
  const units = unitsOf(build, script);
  const reads = display ?? units;
  let sel = "";
  if (selection?.length) {
    const stale = build && selection.some((s) => s.rev !== build.rev);
    sel = `\nSelected faces (picked in the viewer for this message; part coordinates, ${units}, Z up):
${describeSelection(selection, units)}${
      stale
        ? `\n(Some were picked on another build than the current rev ${build.rev}; their face numbers may have changed. Rely on the centre, normal and point.)`
        : ""
    }`;
  }
  return `<studio-context>
Part: ${part}.js
Units: the script is in ${UNIT_LABELS[units]} (${units}); the user reads ${UNIT_LABELS[reads]} (${reads}).
Current script:
${numbered(script ?? "")}
Scene: ${JSON.stringify(scene)}
Last build: ${JSON.stringify(b)}${sel}
</studio-context>`;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A tool error the model can act on, in the shape the local studio used. */
const fail = (e: unknown) => ({ ok: false as const, error: msg(e) });

async function scriptOf(part: string): Promise<string> {
  const s = await store.readScript(part);
  if (s === null) throw new store.StoreError(`no part \`${part}\``);
  return s;
}

/** The current build, described, for calls that changed nothing. */
async function currentBuild(part: string, note: string) {
  const [b, script] = await Promise.all([store.readBuild(part), store.readScript(part)]);
  const out = b ? describeBuild(b, script ?? undefined) : describeBuild(await buildPart(part), script ?? undefined);
  return { ...out, note };
}

/** A build result plus the change to the script, for the chat's diff view. */
function withDiff(build: Record<string, unknown>, before: string, after: string, part: string) {
  const { diff, stat } = unifiedDiff(before, after, { name: `${part}.js` });
  const script_diff: ScriptDiff = { diff, ...stat };
  return { ...build, script_diff };
}

/** The model sees build results without the UI's diff. */
function withoutDiff({ output }: { output: unknown }): ToolResultOutput {
  if (output && typeof output === "object" && "script_diff" in output) {
    const rest = { ...(output as Record<string, unknown>) };
    delete rest.script_diff;
    return { type: "json", value: rest as JSONValue };
  }
  return typeof output === "string" ? { type: "text", value: output } : { type: "json", value: (output ?? null) as JSONValue };
}

const paramValue = z.union([z.number(), z.boolean(), z.string(), z.null()]);
const view = z.union([z.string(), z.array(z.number()).length(3)]);
const point = z.array(z.number()).length(3);

const round = (v: number[], d = 2) => v.map((x) => +x.toFixed(d));
const unit = (v: number[]) => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    if (signal?.aborted) return rej(signal.reason ?? new Error("aborted"));
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), rej(signal.reason ?? new Error("aborted"))), { once: true });
  });

/** look_at_part's sheet: small and quick. */
const LOOK = { views: ["iso", "top", "front"] as (string | [number, number, number])[], tile: 384, spp: 48, waitMs: 60_000 };

/** The tools, bound to one part and the model of this turn. Errors come back as
 *  `{ok: false, error}` results. */
export function agentTools(part: string, opts: { vision?: boolean } = {}) {
  const vision = !!opts.vision;
  // One tool at a time: the part's files are read-modify-write, and a model may call several
  // tools in one step.
  let queue: Promise<unknown> = Promise.resolve();
  const guard =
    <A, R, O>(f: (a: A, o: O) => Promise<R>) =>
    (a: A, o: O) => {
      const run = queue.then(async () => {
        try {
          return await f(a, o);
        } catch (e) {
          return fail(e);
        }
      });
      queue = run.catch(() => {});
      return run;
    };
  // Renders taken in this request, by tool call id, as base64 PNG. Only these go to the model
  // as images; renders from earlier turns are not re-sent (they would cost tokens every turn).
  const images = new Map<string, string>();

  return {
    read_script: tool({
      description: "Read the current part script, with line numbers.",
      inputSchema: z.object({}),
      execute: guard(async () => ({ script: numbered(await scriptOf(part)) })),
    }),
    edit_script: tool({
      description:
        "Apply exact text replacements to the script, then rebuild. Each old_text must occur exactly once in the current script (include enough context). If any edit fails nothing is changed. Returns the build result.",
      inputSchema: z.object({
        edits: z.array(z.object({ old_text: z.string(), new_text: z.string() })).min(1),
      }),
      execute: guard(async ({ edits }: { edits: { old_text: string; new_text: string }[] }) => {
        const before = await scriptOf(part);
        let src = before;
        for (const [i, e] of edits.entries()) {
          if (!e.old_text) return fail(`edit ${i}: empty old_text; nothing was changed`);
          const n = src.split(e.old_text).length - 1;
          if (n === 0) return fail(`edit ${i}: old_text not found; nothing was changed. Read the script and retry.`);
          if (n > 1) return fail(`edit ${i}: old_text occurs ${n} times; add context. Nothing was changed.`);
          const at = src.indexOf(e.old_text);
          src = src.slice(0, at) + e.new_text + src.slice(at + e.old_text.length);
        }
        if (src === before) return currentBuild(part, "nothing changed; this is the current build");
        return withDiff(describeBuild(await saveAndBuild(part, src), src), before, src, part);
      }),
      toModelOutput: withoutDiff,
    }),
    write_script: tool({
      description: "Replace the whole script, then rebuild. Returns the build result.",
      inputSchema: z.object({ source: z.string().min(1) }),
      execute: guard(async ({ source }: { source: string }) => {
        const before = (await store.readScript(part)) ?? "";
        return withDiff(describeBuild(await saveAndBuild(part, source), source), before, source, part);
      }),
      toModelOutput: withoutDiff,
    }),
    set_params: tool({
      description: "Override parameter values (null resets one to its default), then rebuild. Returns the build result.",
      inputSchema: z.object({ values: z.record(z.string(), paramValue) }),
      execute: guard(async ({ values }: { values: Record<string, string | number | boolean | null> }) => {
        const { build } = await updateScene(part, { params: values });
        if (!build) return currentBuild(part, "nothing changed; this is the current build");
        return describeBuild(build, (await store.readScript(part)) ?? undefined);
      }),
    }),
    get_report: tool({
      description: "The last build's full validation report (without the face table), or its error.",
      inputSchema: z.object({}),
      execute: guard(async () => (await store.readBuild(part)) ?? { ok: false, error: "not built yet" }),
    }),
    get_faces: tool({
      description:
        "The B-rep face table of the last good build: face number, surface type, centre and unit normal (part coordinates, in the script's units). Filter by `type` (plane, cylinder, cone, sphere, torus, bspline, revolution, extrusion, offset; Replicad's names such as CYLINDRE also work), by `near` a point (sorted by centre distance, optionally `within` a distance; both in the script's units) and by `facing` a direction (normal within 10°). Face numbers change with the topology: use them to understand the part, not in the script.",
      inputSchema: z.object({
        type: z.string().optional(),
        near: point.optional(),
        within: z.number().positive().optional(),
        facing: point.optional(),
        limit: z.number().int().min(1).max(200).optional().describe("default 30"),
      }),
      execute: guard(
        async ({ type, near, within, facing, limit }: { type?: string; near?: number[]; within?: number; facing?: number[]; limit?: number }) => {
          const [faces, build, script] = await Promise.all([store.readFaces(part), store.readBuild(part), store.readScript(part)]);
          if (!faces.length) return fail("no face table yet: the part has no good build");
          // The face table is mm; the model works in the script's units.
          const u = unitsOf(build, script);
          near = near?.map((x) => toMm(x, u));
          within = within === undefined ? undefined : toMm(within, u);
          let rows: (Face & { distance?: number })[] = faces;
          if (type) rows = rows.filter((f) => surfaceLabel(f.type) === surfaceLabel(type));
          if (facing) {
            const d = unit(facing);
            rows = rows.filter((f) => {
              const n = unit(f.normal);
              return n[0] * d[0] + n[1] * d[1] + n[2] * d[2] >= Math.cos((10 * Math.PI) / 180);
            });
          }
          if (near) {
            rows = rows
              .map((f) => ({ ...f, distance: Math.hypot(f.center[0] - near[0], f.center[1] - near[1], f.center[2] - near[2]) }))
              .filter((f) => within === undefined || f.distance! <= within)
              .sort((a, b) => a.distance! - b.distance!);
          }
          const n = limit ?? 30;
          return {
            ok: true,
            ...(build && !build.ok ? { note: `the last build (rev ${build.rev}) failed; these faces are from the last good build` } : { rev: build?.rev }),
            total: faces.length,
            matched: rows.length,
            units: u,
            faces: rows.slice(0, n).map((f) => ({
              face: f.face,
              type: f.type,
              center: round(f.center.map((x) => fromMm(x, u)), u === "mm" ? 2 : 4),
              normal: round(unit(f.normal), 3),
              ...(f.distance !== undefined ? { distance: +fromMm(f.distance, u).toFixed(u === "mm" ? 2 : 4) } : {}),
            })),
          };
        },
      ),
    }),
    get_scene: tool({
      description: "The scene document (params, material, environment, background, exposure, camera) and the resolved material.",
      inputSchema: z.object({}),
      execute: guard(async () => {
        const scene = await store.readScene(part);
        return { scene, resolved: resolve(scene) };
      }),
    }),
    update_scene: tool({
      description:
        "Apply a JSON merge patch to the scene document (null deletes a key). Returns the new scene or a validation error; rebuilds when `params` changed.",
      inputSchema: z.object({ patch: z.record(z.string(), z.any()) }),
      execute: guard(async ({ patch }: { patch: Record<string, unknown> }) => {
        try {
          const { scene, build } = await updateScene(part, patch);
          const out: Record<string, unknown> = { ok: true, scene };
          if (build) out.build = describeBuild(build, (await store.readScript(part)) ?? undefined);
          return out;
        } catch (e) {
          if (e instanceof SceneError) return fail(`${e.message}; the scene was not changed`);
          throw e;
        }
      }),
    }),
    list_finishes: tool({
      description: "The finish library: names and labels.",
      inputSchema: z.object({}),
      execute: guard(async () => FINISHES),
    }),
    look_at_part: tool({
      description: vision
        ? "Render the current good build as a small path-traced sheet in the scene's look and look at it (5–15 s). Default views: iso, top, front; `views` are view names (iso, front, side, top, rear, rear-iso) or [x,y,z] directions, at most 4. Returns the image and the build numbers. Use it to verify visual changes, not after every edit."
        : "Render the current good build as a small path-traced sheet for the user (you cannot see images; 5–15 s). Default views: iso, top, front. Returns the build numbers.",
      inputSchema: z.object({ views: z.array(view).min(1).max(4).optional() }),
      execute: guard(async ({ views }: { views?: (string | number[])[] }, { toolCallId, abortSignal }: { toolCallId: string; abortSignal?: AbortSignal }) => {
        const scene = await store.readScene(part);
        const v = (views?.length ? views : LOOK.views) as (string | [number, number, number])[];
        let job = await startRender({ kind: "sheet", inputs: [{ part }], views: v, tile: LOOK.tile, spp: LOOK.spp, source: "preview", ...renderLook(scene) });
        const t0 = Date.now();
        while (job.status === "pending") {
          if (Date.now() - t0 > LOOK.waitMs)
            return fail(`the render did not finish in ${LOOK.waitMs / 1000} s; it keeps running as ${job.id} under Render. Carry on without it.`);
          await sleep(1500, abortSignal);
          job = await refresh(job);
        }
        if (job.status === "failed") return fail(`render failed: ${job.error ?? "unknown error"}`);
        const [png, build, script] = await Promise.all([store.readJobImage(job.id), store.readBuild(part), store.readScript(part)]);
        if (!png) return fail(`render ${job.id} finished but its image is missing`);
        images.set(toolCallId, png.toString("base64"));
        const out: LookResult & { build: Record<string, unknown> | null } = {
          ok: true,
          job: job.id,
          image: `/api/renders/${job.id}/image`,
          views: v,
          seconds: job.seconds,
          seen: vision,
          build: build ? describeBuild(build, script ?? undefined) : null,
        };
        return out;
      }),
      toModelOutput: ({ toolCallId, output }): ToolResultOutput => {
        const o = output as Partial<LookResult> & { build?: unknown; ok?: boolean };
        if (!o || o.ok !== true) return { type: "json", value: (o ?? null) as JSONValue };
        const facts = { job: o.job, views: o.views, build: o.build } as JSONValue;
        const b64 = images.get(toolCallId);
        if (vision && b64)
          return {
            type: "content",
            value: [
              { type: "text", text: `Rendered sheet (one labelled tile per view, in the scene's look):\n${JSON.stringify(facts)}` },
              { type: "file", mediaType: "image/png", data: { type: "data", data: b64 }, filename: `${o.job}.png` },
            ],
          };
        if (vision)
          return { type: "text", value: `A render from an earlier turn (not re-sent; call look_at_part again to see the current part): ${JSON.stringify(facts)}` };
        return { type: "text", value: `This model cannot see images; the render was shown to the user only. Check the build numbers instead: ${JSON.stringify(facts)}` };
      },
    }),
    render_sheet: tool({
      description:
        'Queue a full-quality path-traced contact sheet of the current build in the scene\'s look (a final render for the user; you do not see it). `views` are view names or [x,y,z] directions; with neither views nor orbit you get iso, front, side and top. `orbit` is "N@DEG": N views evenly spaced around the part (360/N degrees apart), DEG degrees above the horizon; e.g. a 12-view turntable is "12@20". Returns the job id and tile count; the user sees it under Render.',
      inputSchema: z.object({
        views: z.array(view).optional(),
        orbit: z.string().optional(),
        spp: z.number().int().min(1).max(4096).optional().describe("samples per pixel, default 256"),
      }),
      execute: guard(async ({ views, orbit, spp }: { views?: (string | number[])[]; orbit?: string; spp?: number }) => {
        const job = await startPartSheet(part, { views: views as (string | [number, number, number])[] | undefined, orbit: orbit ?? null, spp, source: "agent" });
        const req = job.request as { views?: unknown[]; orbit?: string | null };
        const orbitN = req.orbit ? parseInt(req.orbit, 10) || 0 : 0;
        return { ok: true, job: job.id, status: job.status, views: req.views, orbit: req.orbit, tiles: Math.max(1, (req.views?.length ?? 0) + orbitN) };
      }),
    }),
  } satisfies ToolSet;
}

export type AgentTools = ReturnType<typeof agentTools>;
