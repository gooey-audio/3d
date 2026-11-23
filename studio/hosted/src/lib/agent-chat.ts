// Helpers for the chat routes: request validation, history preparation and error text.
// Server-only.
import "server-only";
import { APICallError } from "ai";
import { MAX_SELECTION, type ChatMessage } from "./agent-shared";
import type { FaceSelection } from "./selection";

import { MAX_CHAT_TEXT } from "./chat-quota-shared";

const vec3 = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));

/** The faces sent with a message, validated; malformed entries are dropped. */
export function parseSelection(v: unknown): FaceSelection[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (s): s is FaceSelection =>
        !!s &&
        typeof s === "object" &&
        Number.isInteger((s as FaceSelection).face) &&
        typeof (s as FaceSelection).type === "string" &&
        vec3((s as FaceSelection).center) &&
        vec3((s as FaceSelection).normal) &&
        vec3((s as FaceSelection).point) &&
        typeof (s as FaceSelection).rev === "number",
    )
    .slice(0, MAX_SELECTION)
    .map(({ face, type, center, normal, point, rev }) => ({ face, type: type.slice(0, 40), center, normal, point, rev }));
}

/** The request's user message, normalised (text parts only; metadata only `selection`), or an
 *  error string. */
export function parseUserMessage(v: unknown): ChatMessage | string {
  const m = v as Partial<ChatMessage> | null;
  if (!m || typeof m !== "object" || typeof m.id !== "string" || !m.id || m.id.length > 100 || m.role !== "user" || !Array.isArray(m.parts)) {
    return "`message` must be the user's UI message ({id, role: \"user\", parts})";
  }
  const parts = m.parts.filter((p): p is { type: "text"; text: string } => !!p && p.type === "text" && typeof (p as { text?: unknown }).text === "string");
  const text = parts.map((p) => p.text).join("");
  if (!text.trim()) return "the message is empty";
  if (text.length > MAX_CHAT_TEXT) return `the message is too long (${text.length} characters; at most ${MAX_CHAT_TEXT})`;
  const selection = parseSelection(m.metadata?.selection);
  return { id: m.id, role: "user", parts: parts.map((p) => ({ type: "text", text: p.text })), ...(selection.length ? { metadata: { selection } } : {}) };
}

/** The conversation for a turn: the stored history with the new user message. A message whose
 *  id is already stored replaces it and drops what came after (regenerate, retry); otherwise it
 *  is appended. */
export function mergeHistory(stored: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const at = stored.findIndex((m) => m.id === message.id);
  return at >= 0 ? [...stored.slice(0, at), message] : [...stored, message];
}

export function isMessageList(v: unknown): v is ChatMessage[] {
  return (
    Array.isArray(v) &&
    v.every(
      (m) =>
        m &&
        typeof m === "object" &&
        typeof (m as ChatMessage).id === "string" &&
        ["user", "assistant", "system"].includes((m as ChatMessage).role) &&
        Array.isArray((m as ChatMessage).parts),
    )
  );
}

/** Earlier turns as the model sees them: no system messages from the client, no reasoning, no
 *  provider custom parts (e.g. anthropic.message_start usage records), and no provider metadata (a turn may have run on another model; ids and signatures from one
 *  provider confuse another). Tool calls that never got a result are dropped at conversion. */
export function prepareHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role !== "assistant") return m;
      const parts = m.parts
        .filter((p) => p.type !== "reasoning" && p.type !== "custom")
        .map((p) => {
          const rest = { ...p } as typeof p & { providerMetadata?: unknown; callProviderMetadata?: unknown };
          delete rest.providerMetadata;
          delete rest.callProviderMetadata;
          return rest as typeof p;
        });
      return { ...m, parts };
    })
    .filter((m) => m.role !== "assistant" || m.parts.length > 0);
}

/** A readable error line for the UI, prefixed with the model id. */
export function errorText(model: string, error: unknown): string {
  let text = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
  if (APICallError.isInstance(error)) {
    const status = error.statusCode ? ` (HTTP ${error.statusCode})` : "";
    // The body only when the message is generic ("Bad Request"); usually it repeats the message.
    const body = error.responseBody && text.length < 40 ? `: ${error.responseBody.slice(0, 300)}` : "";
    text = `${text}${status}${body}`;
  }
  return `${model}: ${text.slice(0, 800)}`;
}
