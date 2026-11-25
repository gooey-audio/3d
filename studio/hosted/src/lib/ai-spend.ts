// The global monthly AI budget, a failsafe against surprise provider bills. `deepseek-direct`
// bypasses the AI Gateway (and its project budget), so the studio keeps its own ledger in
// `studio.ai_spend` (db/002_ai_spend.sql). Admission (reserveChatTurn in lib/chat-quota.ts,
// under the quota lock) reserves STUDIO_AI_TURN_RESERVE_USD per turn so concurrent turns cannot
// all slip under the budget; the turn then settles to its cost. A turn that never settles keeps
// its reservation counted. Months are UTC calendar months. The budget applies to every account.
import "server-only";
import { neon } from "@neondatabase/serverless";
import { gateway, type LanguageModelUsage, type ProviderMetadata } from "ai";
import { modelPrice } from "./models";

function usd(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const amount = Number(value);
  if (!/^\d+(\.\d+)?$/.test(value) || !Number.isFinite(amount)) throw new Error(`Invalid ${name}`);
  return amount;
}

export function budgetConfig() {
  return {
    budgetUsd: usd("STUDIO_AI_MONTHLY_BUDGET_USD", 100),
    reserveUsd: usd("STUDIO_AI_TURN_RESERVE_USD", 0.5),
  };
}

/** Whether a new turn's reservation still fits in the month. Keep in step with reserveChatTurn's SQL. */
export function budgetAllows(spentUsd: number, { budgetUsd, reserveUsd }: ReturnType<typeof budgetConfig>): boolean {
  return budgetUsd > 0 && spentUsd < budgetUsd && spentUsd + reserveUsd <= budgetUsd;
}

function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return neon(url);
}

export type AiSpend = { spentUsd: number; budgetUsd: number; periodStart: string; periodEnd: string };

/** This UTC month's spend (unsettled turns count at their reservation). For an admin page. */
export async function aiSpend(): Promise<AiSpend> {
  const sql = database();
  const [row] = await sql`
    WITH period AS (
      SELECT date_trunc('month', statement_timestamp() AT TIME ZONE 'UTC')::date AS month
    )
    SELECT coalesce(sum(coalesce(s.cost_usd, s.reserved_usd)), 0)::float8 AS spent,
           (p.month::timestamp AT TIME ZONE 'UTC') AS period_start,
           ((p.month + interval '1 month') AT TIME ZONE 'UTC') AS period_end
    FROM period p LEFT JOIN studio.ai_spend s ON s.month = p.month
    GROUP BY p.month
  `;
  return {
    spentUsd: Number(row.spent),
    budgetUsd: budgetConfig().budgetUsd,
    periodStart: new Date(row.period_start).toISOString(),
    periodEnd: new Date(row.period_end).toISOString(),
  };
}

// For a model call whose usage never arrived (stopped mid-stream): assume a large prompt and the
// full output cap, to err high.
const UNKNOWN_INPUT_TOKENS = 30_000;
// Anthropic bills cache writes at up to 2x input; others bill them as input or not at all.
const CACHE_WRITE_FACTOR = 2;

type Call = { estimateUsd: number; generationId?: string };
type Tokens = { input?: number; cacheRead?: number; cacheWrite?: number; output?: number };

/**
 * Collects a turn's model calls from streamText's callbacks. Steps run one at a time, so at most
 * one call is open; one still open when the turn ends was cut off and is estimated at its cap.
 */
export class TurnMeter {
  private calls: Call[] = [];
  private open = false;
  private lastInput: number | undefined;

  constructor(
    private modelId: string,
    private maxOutputTokens: number,
  ) {}

  start() {
    this.open = true;
  }

  end(usage: LanguageModelUsage, providerMetadata: ProviderMetadata | undefined) {
    this.open = false;
    if (usage.inputTokens != null) this.lastInput = usage.inputTokens;
    const id = providerMetadata?.gateway?.generationId;
    this.calls.push({
      estimateUsd: this.estimate({
        input: usage.inputTokens,
        cacheRead: usage.inputTokenDetails?.cacheReadTokens,
        cacheWrite: usage.inputTokenDetails?.cacheWriteTokens,
        output: usage.outputTokens,
      }),
      generationId: typeof id === "string" ? id : undefined,
    });
  }

  /** The provider call threw or its stream ended without output: nothing to bill. */
  fail() {
    this.open = false;
  }

  /** The calls so far, plus the cut-off call (if any) at its estimate. */
  snapshot(): Call[] {
    return this.open ? [...this.calls, { estimateUsd: this.estimate({}) }] : [...this.calls];
  }

  /** Unknown counts err high: the larger of the last prompt and UNKNOWN_INPUT_TOKENS, the output cap. */
  private estimate(t: Tokens): number {
    const price = modelPrice(this.modelId);
    const input = t.input ?? Math.max(this.lastInput ?? 0, UNKNOWN_INPUT_TOKENS);
    const read = t.cacheRead ?? 0;
    const write = t.cacheWrite ?? 0;
    const fresh = Math.max(0, input - read - write);
    const output = t.output ?? this.maxOutputTokens;
    return (fresh * price.input + read * (price.cachedInput ?? price.input) + write * price.input * CACHE_WRITE_FACTOR + output * price.output) / 1e6;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timed out")), ms)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The gateway's billed cost of a generation; it may lag the stream briefly, so retry once. */
async function gatewayCost(id: string): Promise<number | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000));
    try {
      const info = await withTimeout(gateway.getGenerationInfo({ id }), 5000);
      // With BYOK the provider bills `upstreamInferenceCost` directly; count the larger to err high.
      const cost = Math.max(info.totalCost, info.upstreamInferenceCost ?? 0);
      if (Number.isFinite(cost) && cost >= 0) return cost;
    } catch {
      // Fall back to the estimate below.
    }
  }
  return null;
}

/** Replaces the turn's reservation with its cost. Never throws: on failure the reservation stays. */
export async function settleTurn(spendId: string | null, meter: TurnMeter, label: string): Promise<void> {
  if (!spendId) return;
  try {
    const calls = meter.snapshot();
    // Prefer what the gateway billed; estimate the rest (deepseek-direct, failed lookups).
    const billed = await Promise.all(calls.map((c) => (c.generationId ? gatewayCost(c.generationId) : null)));
    const total = calls.reduce((sum, c, i) => sum + (billed[i] ?? c.estimateUsd), 0);
    const reported = billed.filter((b) => b !== null).length;
    const source = !calls.length ? "none" : reported === calls.length ? "gateway" : reported ? "mixed" : "estimate";
    const sql = database();
    await sql`
      UPDATE studio.ai_spend
      SET cost_usd = ${total.toFixed(6)}::numeric, cost_source = ${source}, settled_at = now()
      WHERE id = ${spendId} AND cost_usd IS NULL
    `;
  } catch (e) {
    console.error(`[chat ${label}] could not record the turn's AI spend (its reservation stays counted):`, e);
  }
}
