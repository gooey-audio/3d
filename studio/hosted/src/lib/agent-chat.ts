// Helpers for the chat routes: request validation, history preparation and error text.
// Server-only.
import "server-only";
import { APICallError } from "ai";
import type { ChatMessage } from "./agent-shared";

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

/** Earlier turns as the model sees them: no system messages from the client, no reasoning, and
 *  no provider metadata (a turn may have run on another model; ids and signatures from one
 *  provider confuse another). Tool calls that never got a result are dropped at conversion. */
export function prepareHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role !== "assistant") return m;
      const parts = m.parts
        .filter((p) => p.type !== "reasoning")
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
