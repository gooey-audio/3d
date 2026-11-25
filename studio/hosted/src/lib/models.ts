// The models the agent can run on. Server-only (it builds provider instances); the picker
// reads the list from `GET /api/chat/models`.
//
// `deepseek-direct` talks to DeepSeek with DEEPSEEK_API_KEY. Every other entry is a Vercel AI
// Gateway model string ("provider/model"): on Vercel the gateway authenticates with the
// deployment's OIDC token; locally with VERCEL_OIDC_TOKEN (`vercel env pull`) or
// AI_GATEWAY_API_KEY. IDs checked against `gateway.getAvailableModels()` on 2026-11-19.
//
// `vision`: the model accepts images (look_at_part returns its render as an image content part).
// From the gateway's public model list (`GET https://ai-gateway.vercel.sh/v1/models`: tag
// "vision", modalities.input includes "image"), checked 2026-11-19. DeepSeek's own API
// (`deepseek-chat`) is text-only.
//
// `price`: USD per million tokens, for the monthly AI budget (lib/ai-spend.ts). These are
// estimates that deliberately err high: gateway turns settle to the gateway's reported cost when
// it can be looked up, so the table only matters for `deepseek-direct` (which bypasses the
// gateway and its budget) and as a fallback. Review them when adding a model.
import "server-only";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { gateway, type LanguageModel } from "ai";

type Reasoning = "provider-default" | "none" | "minimal" | "low" | "medium" | "high";

/** USD per million tokens. `cachedInput`: cache reads (default: `input`). */
export type Price = { input: number; cachedInput?: number; output: number };

type Entry = {
  id: string;
  label: string;
  /** Who serves it, for the picker's groups. */
  vendor: string;
  via: "deepseek" | "gateway";
  /** Provider model id (DeepSeek) or gateway model string. */
  model: string;
  /** The portable `reasoning` setting for streamText (omitted: the provider's default). */
  reasoning?: Reasoning;
  /** Accepts image input (also in tool results). */
  vision: boolean;
  /** Estimated price, erring high (see above). */
  price: Price;
};

export const DEFAULT_MODEL = "deepseek-direct";

const ENTRIES: Entry[] = [
  { id: "deepseek-direct", label: "DeepSeek Chat (direct)", vendor: "DeepSeek", via: "deepseek", model: "deepseek-chat", vision: false, price: { input: 0.6, cachedInput: 0.15, output: 2.2 } },
  { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5", vendor: "Anthropic", via: "gateway", model: "anthropic/claude-sonnet-5.5", reasoning: "low", vision: true, price: { input: 4, cachedInput: 0.4, output: 20 } },
  { id: "anthropic/claude-opus-5.5", label: "Claude Opus 5.5", vendor: "Anthropic", via: "gateway", model: "anthropic/claude-opus-5.5", reasoning: "low", vision: true, price: { input: 15, cachedInput: 1.5, output: 75 } },
  { id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5", vendor: "Anthropic", via: "gateway", model: "anthropic/claude-haiku-5.5", vision: true, price: { input: 2, cachedInput: 0.2, output: 10 } },
  { id: "openai/gpt-6.2-sol", label: "GPT-6.2 Sol", vendor: "OpenAI", via: "gateway", model: "openai/gpt-6.2-sol", reasoning: "low", vision: true, price: { input: 5, cachedInput: 0.5, output: 40 } },
  { id: "openai/gpt-6-luna", label: "GPT-6 Luna", vendor: "OpenAI", via: "gateway", model: "openai/gpt-6-luna", vision: true, price: { input: 1, cachedInput: 0.1, output: 8 } },
  { id: "google/gemini-4-neon", label: "Gemini 4 Neon", vendor: "Google", via: "gateway", model: "google/gemini-4-neon", vision: true, price: { input: 4, cachedInput: 0.4, output: 24 } },
  { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash", vendor: "Google", via: "gateway", model: "google/gemini-3.8-flash", vision: true, price: { input: 0.6, cachedInput: 0.06, output: 4 } },
  { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro (gateway)", vendor: "DeepSeek", via: "gateway", model: "deepseek/deepseek-v4-pro", vision: false, price: { input: 2, cachedInput: 0.2, output: 8 } },
  { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash (gateway)", vendor: "DeepSeek", via: "gateway", model: "deepseek/deepseek-v4.1-flash", vision: true, price: { input: 0.5, cachedInput: 0.05, output: 2 } },
  { id: "moonshotai/kimi-k3.1-pro", label: "Kimi K3.1 Pro", vendor: "Moonshot", via: "gateway", model: "moonshotai/kimi-k3.1-pro", vision: true, price: { input: 2, cachedInput: 0.2, output: 10 } },
  { id: "alibaba/qwen4-max", label: "Qwen 4 Max", vendor: "Alibaba", via: "gateway", model: "alibaba/qwen4-max", vision: true, price: { input: 3, cachedInput: 0.3, output: 15 } },
  { id: "spacexai/grok-4.7", label: "Grok 4.7", vendor: "xAI", via: "gateway", model: "spacexai/grok-4.7", vision: true, price: { input: 5, cachedInput: 0.5, output: 25 } },
  { id: "zai/glm-5.3", label: "GLM 5.3", vendor: "Z.ai", via: "gateway", model: "zai/glm-5.3", vision: false, price: { input: 2, cachedInput: 0.2, output: 8 } },
];

const BY_ID = new Map(ENTRIES.map((e) => [e.id, e]));

/** What the picker shows. `available` is false when the credentials for the route are missing. */
export type ModelInfo = { id: string; label: string; vendor: string; via: "deepseek" | "gateway"; vision: boolean; available: boolean };

function hasCredentials(via: Entry["via"]): boolean {
  if (via === "deepseek") return !!process.env.DEEPSEEK_API_KEY?.trim();
  return !!(process.env.VERCEL || process.env.VERCEL_OIDC_TOKEN || process.env.AI_GATEWAY_API_KEY);
}

export function listModels(): { default: string; models: ModelInfo[] } {
  return {
    default: DEFAULT_MODEL,
    models: ENTRIES.map(({ id, label, vendor, via, vision }) => ({ id, label, vendor, via, vision, available: hasCredentials(via) })),
  };
}

export function isModel(id: unknown): id is string {
  return typeof id === "string" && BY_ID.has(id);
}

export function modelLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}

/** Whether the model accepts images (false for unknown ids). */
export function modelVision(id: string): boolean {
  return BY_ID.get(id)?.vision ?? false;
}

/** The model's estimated price (unknown ids: the most expensive entry, to err high). */
export function modelPrice(id: string): Price {
  return BY_ID.get(id)?.price ?? ENTRIES.reduce((a, e) => (e.price.output > a.output ? e.price : a), ENTRIES[0].price);
}

let deepseek: ReturnType<typeof createDeepSeek> | null = null;

/** The model and its call settings. Throws on an unknown id (check with isModel first). */
export function resolveModel(id: string): { model: LanguageModel; reasoning?: Reasoning; via: Entry["via"]; vision: boolean } {
  const e = BY_ID.get(id);
  if (!e) throw new Error(`unknown model \`${id}\``);
  if (e.via === "deepseek") {
    if (!process.env.DEEPSEEK_API_KEY?.trim()) throw new Error("DEEPSEEK_API_KEY is not set on the server");
    deepseek ??= createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY.trim() });
    return { model: deepseek(e.model), reasoning: e.reasoning, via: e.via, vision: e.vision };
  }
  return { model: gateway(e.model), reasoning: e.reasoning, via: e.via, vision: e.vision };
}
