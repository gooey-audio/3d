// POST /api/chat: one agent turn for a part, streamed as a UI message stream.
// Body (ChatRequest): { part, model, message, trigger? }. Only the new user message travels; the
// history is the stored conversation (`parts/<part>/chat.json`). A message whose id is already
// stored replaces it and everything after it (regenerate, retry). The turn holds the part's
// lock (`turn.json`, lib/agent-lock.ts): 409 while another turn runs. The part is checkpointed
// before anything changes; the checkpoint id is the response message's `metadata.checkpoint`.
// The conversation is stored when the turn ends, also when it was stopped or failed, and the
// lock is released after that. Admission also reserves part of the monthly AI budget; the
// turn's cost replaces the reservation when it ends (lib/ai-spend.ts).
import { after } from "next/server";
import { errorResponse, fail, route } from "@/lib/http";
import { reserveChatTurn } from "@/lib/chat-quota";
import { settleTurn, TurnMeter } from "@/lib/ai-spend";
import { CHAT_LIMIT } from "@/lib/chat-quota-shared";
import { inWorkspace } from "@/lib/workspace";
import { convertToModelMessages, createIdGenerator, createUIMessageStreamResponse, isStepCount, streamText, toUIMessageStream, type ModelMessage } from "ai";
import { agentTools, context, systemPrompt } from "@/lib/agent";
import * as lock from "@/lib/agent-lock";
import { MAX_STEPS, type ChatMessage, type ChatMeta } from "@/lib/agent-shared";
import { isModel, modelLabel, resolveModel } from "@/lib/models";
import { errorText, mergeHistory, parseSelection, parseUserMessage, prepareHistory } from "@/lib/agent-chat";
import * as store from "@/lib/store";
import { parseUnits } from "@/lib/units";

export const maxDuration = 300;

const MAX_OUTPUT_TOKENS = 4096;

const bad = (status: number, error: string) => Response.json({ error }, { status });

export const POST = route(async (req, _ctx, accountId, { admin }) => {
  let body: { part?: unknown; model?: unknown; message?: unknown; units?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad(400, "body must be JSON");
  }
  if (!body || typeof body !== "object") return bad(400, "body must be a JSON object");
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
    modelMessages = await convertToModelMessages(prepareHistory(messages.slice(-12)), { tools, ignoreIncompleteToolCalls: true });
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
    return errorResponse(e);
  }
  let spendId: string | null = null;
  try {
    const reservation = await reserveChatTurn(accountId, modelId, { unlimited: admin });
    if (!reservation.accepted) {
      const q = reservation.quota;
      throw fail(429, q.budgetExhausted
        ? "The studio’s AI budget for this month is used up."
        : q.sharedLimitReached
          ? "The studio has reached its daily AI limit."
          : "You’ve used all of your free AI turns for today.", { code: CHAT_LIMIT, quota: q });
    }
    spendId = reservation.spendId;
    checkpoint = await store.checkpoint(part);
  } catch (e) {
    // No model call ran: give back the budget reservation (settles at zero).
    await settleTurn(spendId, new TurnMeter(modelId, MAX_OUTPUT_TOKENS), part);
    await unlock();
    throw e;
  }
  const startedAt = Date.now();

  let failure: string | undefined;
  // The turn's model calls, for the monthly AI budget; settled when the turn ends. maxRetries is
  // 0, so every call start is one billed request.
  const meter = new TurnMeter(modelId, MAX_OUTPUT_TOKENS);
  const result = streamText({
    model: resolved.model,
    system: systemPrompt(part, { vision: resolved.vision }),
    messages: modelMessages,
    tools,
    stopWhen: isStepCount(MAX_STEPS),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxRetries: 0,
    abortSignal: req.signal,
    ...(resolved.reasoning ? { reasoning: resolved.reasoning } : {}),
    // Gateway: prompt caching where the provider supports it; OpenAI: stream reasoning summaries.
    providerOptions: resolved.via === "gateway" ? { gateway: { caching: "auto" }, openai: { reasoningSummary: "auto" } } : undefined,
    // Keep the lock alive while the turn makes progress.
    onStepEnd: () => {
      if (!released) void inWorkspace(accountId, () => lock.refresh(part, turn)).catch(() => {});
    },
    onLanguageModelCallStart: () => meter.start(),
    onLanguageModelCallEnd: ({ usage, providerMetadata }) => meter.end(usage, providerMetadata),
    onStepError: () => meter.fail(),
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
    onEnd: ({ messages: all, isAborted, isCancelled }) => inWorkspace(accountId, async () => {
      // Never throws; runs alongside storing the conversation so the lock is not held for it.
      const settled = settleTurn(spendId, meter, part);
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
        await settled;
        saved();
      }
    }),
  });

  return createUIMessageStreamResponse({ stream });
});
