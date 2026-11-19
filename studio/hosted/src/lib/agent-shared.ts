// Agent chat types and helpers shared by the server (route, tools) and the client (ChatPanel).
// No server imports here.
import type { UIMessage } from "ai";

/** Metadata on the assistant message that answers a user turn. */
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
};

export type ChatMessage = UIMessage<ChatMeta>;

/** Request body of `POST /api/chat`. */
export type ChatRequest = { part: string; model: string; messages: ChatMessage[] };

/** Tools whose results change the part (script, scene or build): the UI reloads it. */
export const MUTATING_TOOLS = new Set(["edit_script", "write_script", "set_params", "update_scene"]);

export const MAX_STEPS = 24;

type BuildLike = {
  ok?: boolean;
  size_mm?: number[];
  seconds?: number;
  note?: string;
  error?: { kind?: string; message?: string; line?: number | null } | string;
};

export type ToolSummary = { text: string; state: "run" | "ok" | "err" };

const fmt = (x: number) => (Math.round(x * 10) / 10).toString();

/** A one-line summary of a tool call for its chip. */
export function summarizeTool(name: string, input: unknown, output: unknown, errorText?: string): ToolSummary {
  if (errorText) return { text: errorText, state: "err" };
  if (output === undefined) return { text: "…", state: "run" };
  const r = (output ?? {}) as Record<string, unknown> & BuildLike;
  if (r.ok === false && typeof r.error === "string") return { text: r.error, state: "err" };
  const build = (r.size_mm || (r.error && typeof r.error === "object") ? r : (r.build as BuildLike | undefined)) ?? undefined;
  if (build && build.ok === false && build.error && typeof build.error === "object") {
    const e = build.error;
    return { text: `${e.kind ?? "error"}${e.line ? ` at line ${e.line}` : ""}: ${e.message ?? ""}`, state: "err" };
  }
  if (build?.ok && build.size_mm) {
    const s = build.size_mm.map(fmt).join(" × ");
    const t = build.seconds !== undefined ? ` in ${fmt(build.seconds)}s` : "";
    return { text: `built ${s} mm${t}${build.note ? " (unchanged)" : ""}`, state: "ok" };
  }
  const args = (input ?? {}) as { patch?: Record<string, unknown> };
  switch (name) {
    case "update_scene":
      return { text: Object.keys(args.patch ?? {}).join(", ") || "ok", state: "ok" };
    case "read_script":
      return { text: `${String(r.script ?? "").split("\n").length} lines`, state: "ok" };
    case "list_finishes":
      return { text: `${Array.isArray(output) ? output.length : 0} finishes`, state: "ok" };
    case "render_sheet":
      return { text: `queued ${r.job} (${r.tiles} tiles)`, state: "ok" };
    case "get_report":
      return { text: r.ok ? "report" : "no good build", state: r.ok ? "ok" : "err" };
  }
  return { text: "ok", state: "ok" };
}
