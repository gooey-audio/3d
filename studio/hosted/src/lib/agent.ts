// The embedded CAD agent: system prompt, per-turn context and tools over the shared part
// libraries. A port of studio/server/src/agent.rs. Server-only.
import "server-only";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { buildPart, describeBuild, saveAndBuild, updateScene } from "./parts";
import { startPartSheet } from "./renders";
import { CAD_SKILL } from "./prompts/cad-skill";
import { FINISHES, resolve, SceneError } from "./scene";
import * as store from "./store";

export function numbered(src: string): string {
  return src
    .split("\n")
    .map((l, i) => `${String(i + 1).padStart(4)}| ${l}`)
    .join("\n");
}

export function systemPrompt(part: string): string {
  const finishes = FINISHES.length ? FINISHES.map((f) => f.name).join(", ") : "none loaded; use colours and look overrides";
  return `You are the CAD assistant inside gooey-studio, a live editor for one parametric part: \
\`${part}.js\`, a Replicad script. The user sees the script in an editor and the built part in a \
three.js preview, both updating as soon as you change anything.

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
- Units are millimetres. The part frame is Z up (CAD convention); it is shown resting on a ground \
plane.
- Use set_params to change parameter values; use edit_script to change defaults, ranges or the \
geometry itself.
- Change the look with update_scene (a JSON merge patch over the scene document). The scene's \
\`material\` is a finish name from the library (${finishes}), a colour \`#rrggbb\`, or an object such \
as {"color": "#c0c4c8", "metalness": 1, "roughness": 0.25} or \
{"finish": "wood/walnut", "clearcoat": 0.5} (look keys: roughness, metalness, clearcoat, \
clearcoat_roughness, transmission, ior, opacity, sheen; all 0..1 except ior 1..3). \`environment\` \
is {"type": "studio", "intensity": 1, "rotation_deg": 0} (softbox key, fill and rim \
lights, turned about the vertical axis). \`background\` is \`#rrggbb\` or \`transparent\`; \`exposure\` > \
0; \`camera\` is {"view": "iso"|"front"|"side"|"top"|"rear"|"rear-iso"|[x,y,z], "fov": \
degrees} (Y up in view space).
- render_sheet queues a path-traced contact sheet for the user; only use it when asked for a render.
- Be brief. After changes, summarise what you did in one or two sentences with the key numbers \
(size, holes/genus, printability issues).

Reference: the gooey-3d cad skill (the CLI parts do not apply here; the tools replace them).

${CAD_SKILL}`;
}

/** The fresh state of the part, prepended to the user's message for this turn. */
export async function context(part: string): Promise<string> {
  const [script, scene, build] = await Promise.all([store.readScript(part), store.readScene(part), store.readBuild(part)]);
  const b = build ? describeBuild(build, script ?? undefined) : null;
  return `<studio-context>
Part: ${part}.js
Current script:
${numbered(script ?? "")}
Scene: ${JSON.stringify(scene)}
Last build: ${JSON.stringify(b)}
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

const paramValue = z.union([z.number(), z.boolean(), z.string(), z.null()]);
const view = z.union([z.string(), z.array(z.number()).length(3)]);

/** The tools, bound to one part. Errors come back as `{ok: false, error}` results. */
export function agentTools(part: string) {
  // One tool at a time: the part's files are read-modify-write, and a model may call several
  // tools in one step.
  let queue: Promise<unknown> = Promise.resolve();
  const guard =
    <A, R>(f: (a: A) => Promise<R>) =>
    (a: A) => {
      const run = queue.then(async () => {
        try {
          return await f(a);
        } catch (e) {
          return fail(e);
        }
      });
      queue = run.catch(() => {});
      return run;
    };
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
      execute: guard(async ({ edits }) => {
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
        return describeBuild(await saveAndBuild(part, src), src);
      }),
    }),
    write_script: tool({
      description: "Replace the whole script, then rebuild. Returns the build result.",
      inputSchema: z.object({ source: z.string().min(1) }),
      execute: guard(async ({ source }) => describeBuild(await saveAndBuild(part, source), source)),
    }),
    set_params: tool({
      description: "Override parameter values (null resets one to its default), then rebuild. Returns the build result.",
      inputSchema: z.object({ values: z.record(z.string(), paramValue) }),
      execute: guard(async ({ values }) => {
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
      execute: guard(async ({ patch }) => {
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
    render_sheet: tool({
      description:
        'Queue a path-traced contact sheet of the current build in the scene\'s look (a final render for the user; you cannot see it). `views` are view names or [x,y,z] directions; with neither views nor orbit you get iso, front, side and top. `orbit` is "N@DEG": N views evenly spaced around the part (360/N degrees apart), DEG degrees above the horizon; e.g. a 12-view turntable is "12@20". Returns the job id and tile count; the user sees it under Renders.',
      inputSchema: z.object({
        views: z.array(view).optional(),
        orbit: z.string().optional(),
        spp: z.number().int().min(1).max(4096).optional().describe("samples per pixel, default 256"),
      }),
      execute: guard(async ({ views, orbit, spp }) => {
        const job = await startPartSheet(part, { views: views as (string | [number, number, number])[] | undefined, orbit: orbit ?? null, spp });
        const req = job.request as { views?: unknown[]; orbit?: string | null };
        const orbitN = req.orbit ? parseInt(req.orbit, 10) || 0 : 0;
        return { ok: true, job: job.id, status: job.status, views: req.views, orbit: req.orbit, tiles: Math.max(1, (req.views?.length ?? 0) + orbitN) };
      }),
    }),
  } satisfies ToolSet;
}

export type AgentTools = ReturnType<typeof agentTools>;
