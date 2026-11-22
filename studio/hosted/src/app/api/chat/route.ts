// POST /api/chat: one agent turn for a part, streamed as a UI message stream.
// Body (ChatRequest): { part, model, message, trigger? }. Only the new user message travels; the
// history is the stored conversation (`parts/<part>/chat.json`). A message whose id is already
// stored replaces it and everything after it (regenerate, retry). The turn holds the part's
// lock (`turn.json`, lib/agent-lock.ts): 409 while another turn runs. The part is checkpointed
// before anything changes; the checkpoint id is the response message's `metadata.checkpoint`.
// The conversation is stored when the turn ends, also when it was stopped or failed, and the
// lock is released after that.
import { after } from "next/server";
import { convertToModelMessages, createIdGenerator, createUIMessageStreamResponse, isStepCount, streamText, toUIMessageStream, type ModelMessage } from "ai";
import { agentTools, context, systemPrompt } from "@/lib/agent";
import * as lock from "@/lib/agent-lock";
import { MAX_STEPS, type ChatMessage, type ChatMeta } from "@/lib/agent-shared";
import { isModel, modelLabel, resolveModel } from "@/lib/models";
import { errorText, mergeHistory, parseSelection, parseUserMessage, prepareHistory } from "@/lib/agent-chat";
import * as store from "@/lib/store";
import { parseUnits } from "@/lib/units";

export const maxDuration = 300;

const bad = (status: number, error: string) => Response.json({ error }, { status });

export async function POST(req: Request) {
  let body: { part?: unknown; model?: unknown; message?: unknown; units?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad(400, "body must be JSON");
  }
  const { part, model: modelId } = body;
  if (typeof part !== "string" || !store.validPart(part)) return bad(400, "bad or missing `part`");
  if (!isModel(modelId)) return bad(400, `unknown model \`${String(modelId)}\``);
  const message = parseUserMessage(body.message);
  if (typeof message === "string") return bad(400, message);
  if ((await store.readScript(part)) === null) return bad(404, `no part \`${part}\``);

  let resolved: ReturnType<typeof resolveModel>;
  try {
    resolved = resolveModel(modelId);
  } catch (e) {
    return bad(400, `${modelId}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const got = await lock.acquire(part, modelId);
  if (!got.ok) return Response.json(lock.lockedBody(got.holder, modelLabel(got.holder.model)), { status: 409 });
  const turn = got.lock;
  // Releases the lock exactly once, after the conversation is stored.
  let released = false;
  const unlock = async () => {
    if (released) return;
    released = true;
    await lock.release(part, turn).catch((e) => console.error(`[chat ${part}] could not release the turn lock:`, e));
  };

  let messages: ChatMessage[];
  let modelMessages: ModelMessage[];
  let checkpoint: string;
  const tools = agentTools(part, { vision: resolved.vision });
  try {
    messages = mergeHistory(await store.readChat<ChatMessage>(part), message);
    checkpoint = await store.checkpoint(part);
    modelMessages = await convertToModelMessages(prepareHistory(messages), { tools, ignoreIncompleteToolCalls: true });
    // The fresh part state (and the faces the user picked) go in front of the user's words for
    // this turn only (not stored).
    const last = modelMessages[modelMessages.length - 1];
    if (last?.role === "user") {
      const ctx = { type: "text" as const, text: await context(part, parseSelection(message.metadata?.selection), parseUnits(body.units) ?? undefined) };
      last.content = typeof last.content === "string" ? [ctx, { type: "text", text: last.content }] : [ctx, ...last.content];
    }
  } catch (e) {
    await unlock();
    console.error(`[chat ${part}] could not start the turn:`, e);
    return bad(500, `could not start the turn: ${e instanceof Error ? e.message : String(e)}`);
  }
  const startedAt = Date.now();

  let failure: string | undefined;
  const result = streamText({
    model: resolved.model,
    system: systemPrompt(part, { vision: resolved.vision }),
    messages: modelMessages,
    tools,
    stopWhen: isStepCount(MAX_STEPS),
    abortSignal: req.signal,
    ...(resolved.reasoning ? { reasoning: resolved.reasoning } : {}),
    // Gateway: prompt caching where the provider supports it; OpenAI: stream reasoning summaries.
    providerOptions: resolved.via === "gateway" ? { gateway: { caching: "auto" }, openai: { reasoningSummary: "auto" } } : undefined,
    // Keep the lock alive while the turn makes progress.
    onStepEnd: () => {
      if (!released) void lock.refresh(part, turn).catch(() => {});
    },
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
        await unlock();
        saved();
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
