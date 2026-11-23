// Agent chat types and helpers shared by the server (route, tools) and the client (ChatPanel).
// No server imports here.
import type { UIMessage } from "ai";
import type { FaceSelection } from "./selection";
import { fmtSize, MM_PER_UNIT, parseUnits, type Units } from "./units";

/** Message metadata. On the assistant message that answers a user turn: the turn's facts. On a
 *  user message: what the user pointed at when sending it. */
export type ChatMeta = {
  /** store.checkpoint id taken before the turn changed anything ("revert to before this turn"). */
  checkpoint?: string;
  /** Registry id of the model that ran the turn. */
  model?: string;
  startedAt?: number;
  finishedAt?: number;
  finishReason?: string;
  /** Set when the turn ended on an error (already prefixed with the model). */
  error?: string;
  /** The user stopped the turn. */
  stopped?: boolean;
  /** User messages: faces picked in the viewer, sent as context for this turn. */
  selection?: FaceSelection[];
};

export type ChatMessage = UIMessage<ChatMeta>;

/** Request body of `POST /api/chat`. Only the new user message travels: the server keeps the
 *  history (`parts/<part>/chat.json`). A message whose id is already stored replaces it and
 *  everything after it (regenerate, or a retry after a failed request). */
export type ChatRequest = {
  part: string;
  model: string;
  /** The units the user reads dimensions in (the studio setting). */
  units?: Units;
  message: ChatMessage;
  trigger?: "submit-message" | "regenerate-message";
};

/** `code` of the 409 response when another turn holds the part. */
export const TURN_LOCKED = "turn-locked";

/** Tools whose results change the part (script, scene or build): the UI reloads it. */
export const MUTATING_TOOLS = new Set(["edit_script", "write_script", "set_params", "update_scene"]);

export const MAX_STEPS = 24;

/** At most this many faces ride along with one message. */
export const MAX_SELECTION = 24;

/** Replicad surface type names (the face table's `type`) as the chips show them. */
const SURFACE: Record<string, string> = {
  PLANE: "plane",
  CYLINDRE: "cylinder",
  CONE: "cone",
  SPHERE: "sphere",
  TORUS: "torus",
  BEZIER_SURFACE: "bezier",
  BSPLINE_SURFACE: "bspline",
  REVOLUTION_SURFACE: "revolution",
  EXTRUSION_SURFACE: "extrusion",
  OFFSET_SURFACE: "offset",
  OTHER_SURFACE: "other",
};

export const surfaceLabel = (type: string) => SURFACE[type] ?? type.toLowerCase();

/** "face 12 · plane" */
export const selectionLabel = (s: Pick<FaceSelection, "face" | "type">) => `face ${s.face} · ${surfaceLabel(s.type)}`;

/** The UI part of an edit_script / write_script result (`diff` is stripped for the model). */
export type ScriptDiff = { diff: string; added: number; removed: number };

/** The UI part of a look_at_part result: the render job and where its image is. */
export type LookResult = { ok: true; job: string; image: string; views: unknown[]; seconds?: number; seen: boolean };

type BuildLike = {
  ok?: boolean;
  /** In `units` (parts.describeBuild). Results stored before units existed have `size_mm`. */
  size?: number[];
  units?: string;
  size_mm?: number[];
  seconds?: number;
  note?: string;
  error?: { kind?: string; message?: string; line?: number | null } | string;
};

export type ToolSummary = { text: string; state: "run" | "ok" | "err" };

const fmt = (x: number) => (Math.round(x * 10) / 10).toString();

/** A build result's size in mm. */
function sizeMm(b: BuildLike): number[] | undefined {
  if (b.size_mm) return b.size_mm;
  const u = parseUnits(b.units);
  return b.size && u ? b.size.map((x) => x * MM_PER_UNIT[u]) : undefined;
}

/** A one-line summary of a tool call for its chip; sizes in `display` units. */
export function summarizeTool(name: string, input: unknown, output: unknown, errorText?: string, display: Units = "in"): ToolSummary {
  if (errorText) return { text: errorText, state: "err" };
  if (output === undefined) return { text: name === "look_at_part" ? "rendering…" : "…", state: "run" };
  const r = (output ?? {}) as Record<string, unknown> & BuildLike;
  if (r.ok === false && typeof r.error === "string") return { text: r.error, state: "err" };
  const d = r.script_diff as ScriptDiff | undefined;
  const delta = d && (d.added || d.removed) ? `+${d.added} −${d.removed}, ` : "";
  const build = (sizeMm(r) || (r.error && typeof r.error === "object") ? r : (r.build as BuildLike | undefined)) ?? undefined;
  if (name !== "look_at_part" && build && build.ok === false && build.error && typeof build.error === "object") {
    const e = build.error;
    return { text: `${delta}${e.kind ?? "error"}${e.line ? ` at line ${e.line}` : ""}: ${e.message ?? ""}`, state: "err" };
  }
  const mm = build && sizeMm(build);
  if (name !== "look_at_part" && build?.ok && mm) {
    const t = build.seconds !== undefined ? ` in ${fmt(build.seconds)}s` : "";
    return { text: `${delta}built ${fmtSize(mm, display)}${t}${build.note ? " (unchanged)" : ""}`, state: "ok" };
  }
  const args = (input ?? {}) as { patch?: Record<string, unknown> };
  switch (name) {
    case "update_scene":
      return { text: Object.keys(args.patch ?? {}).join(", ") || "ok", state: "ok" };
    case "read_script":
      return { text: `${String(r.script ?? "").split("\n").length} lines`, state: "ok" };
    case "load_texture_skill":
      return { text: "texture skill loaded", state: "ok" };
    case "list_finishes":
      return { text: `${Array.isArray(output) ? output.length : 0} finishes`, state: "ok" };
    case "render_sheet":
      return { text: `queued ${r.job} (${r.tiles} tiles)`, state: "ok" };
    case "get_report":
      return { text: r.ok ? "report" : "no good build", state: r.ok ? "ok" : "err" };
    case "get_faces":
      return { text: `${(r.faces as unknown[] | undefined)?.length ?? 0} of ${r.total ?? 0} faces`, state: "ok" };
    case "look_at_part": {
      const l = r as unknown as LookResult;
      const t = l.seconds !== undefined ? ` in ${fmt(l.seconds)}s` : "";
      return { text: `${l.views?.length ?? 0} views${t}${l.seen ? "" : " (shown to you; the model cannot see images)"}`, state: "ok" };
    }
  }
  return { text: "ok", state: "ok" };
}
