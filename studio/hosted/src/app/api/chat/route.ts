// POST /api/chat: one agent turn for a part, streamed as a UI message stream.
// Body: { part, model, messages } (UIMessage[], the last one the user's). The part is
// checkpointed before anything changes; the checkpoint id is the response message's
// `metadata.checkpoint`. The conversation is stored (store.writeChat) when the turn ends,
// also when it was stopped or failed.
import { after } from "next/server";
import { convertToModelMessages, createIdGenerator, createUIMessageStreamResponse, isStepCount, streamText, toUIMessageStream, type ModelMessage } from "ai";
import { agentTools, context, systemPrompt } from "@/lib/agent";
import { MAX_STEPS, type ChatMessage, type ChatMeta } from "@/lib/agent-shared";
import { isModel, resolveModel } from "@/lib/models";
import { errorText, isMessageList, prepareHistory } from "@/lib/agent-chat";
import * as store from "@/lib/store";

export const maxDuration = 300;

const bad = (status: number, error: string) => Response.json({ error }, { status });

export async function POST(req: Request) {
  let body: { part?: unknown; model?: unknown; messages?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad(400, "body must be JSON");
  }
  const { part, model: modelId, messages } = body;
  if (typeof part !== "string" || !store.validPart(part)) return bad(400, "bad or missing `part`");
  if (!isModel(modelId)) return bad(400, `unknown model \`${String(modelId)}\``);
  if (!isMessageList(messages) || !messages.length || messages[messages.length - 1].role !== "user") {
    return bad(400, "`messages` must be UI messages ending with the user's");
  }
  if ((await store.readScript(part)) === null) return bad(404, `no part \`${part}\``);

  let resolved: ReturnType<typeof resolveModel>;
  try {
    resolved = resolveModel(modelId);
  } catch (e) {
    return bad(400, `${modelId}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const checkpoint = await store.checkpoint(part);
  const startedAt = Date.now();
  const tools = agentTools(part);

  const history = prepareHistory(messages);
  const modelMessages: ModelMessage[] = await convertToModelMessages(history, { tools, ignoreIncompleteToolCalls: true });
  // The fresh part state goes in front of the user's words for this turn only (not stored).
  const last = modelMessages[modelMessages.length - 1];
  if (last?.role === "user") {
    const ctx = { type: "text" as const, text: await context(part) };
    last.content = typeof last.content === "string" ? [ctx, { type: "text", text: last.content }] : [ctx, ...last.content];
  }

  let failure: string | undefined;
  const result = streamText({
    model: resolved.model,
    system: systemPrompt(part),
    messages: modelMessages,
    tools,
    stopWhen: isStepCount(MAX_STEPS),
    abortSignal: req.signal,
    ...(resolved.reasoning ? { reasoning: resolved.reasoning } : {}),
    // Gateway: prompt caching where the provider supports it; OpenAI: stream reasoning summaries.
    providerOptions: resolved.via === "gateway" ? { gateway: { caching: "auto" }, openai: { reasoningSummary: "auto" } } : undefined,
    onError: ({ error }) => {
      failure ??= errorText(modelId, error);
      console.error(`[chat ${part}] ${failure}`);
    },
  });

  let saved!: () => void;
  const persisted = new Promise<void>((r) => (saved = r));
  after(() => persisted);

  const stream = toUIMessageStream<typeof tools, ChatMessage>({
    stream: result.stream,
    tools,
    originalMessages: messages,
    generateMessageId: createIdGenerator({ prefix: "msg", size: 16 }),
    sendReasoning: true,
    messageMetadata: ({ part: p }): ChatMeta | undefined => {
      if (p.type === "start") return { checkpoint, model: modelId, startedAt };
      if (p.type === "finish") return { checkpoint, model: modelId, startedAt, finishedAt: Date.now(), finishReason: p.finishReason };
      return undefined;
    },
    onError: (error) => {
      failure ??= errorText(modelId, error);
      return failure;
    },
    onEnd: async ({ messages: all, isAborted, isCancelled }) => {
      try {
        let out = all;
        const lastMsg = out[out.length - 1];
        const extra: ChatMeta = {};
        if (failure) extra.error = failure;
        if (isAborted || isCancelled) extra.stopped = true;
        if (lastMsg?.role === "assistant") {
          out = [...out.slice(0, -1), { ...lastMsg, metadata: { checkpoint, model: modelId, startedAt, finishedAt: Date.now(), ...lastMsg.metadata, ...extra } }];
        } else {
          out = [...out, { id: createIdGenerator({ prefix: "msg", size: 16 })(), role: "assistant", parts: [], metadata: { checkpoint, model: modelId, startedAt, finishedAt: Date.now(), ...extra } }];
        }
        await store.writeChat(part, out);
      } catch (e) {
        console.error(`[chat ${part}] could not store the conversation:`, e);
      } finally {
        saved();
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
