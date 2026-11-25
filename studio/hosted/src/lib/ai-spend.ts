// The global monthly AI budget, a failsafe against surprise provider bills. `deepseek-direct`
// bypasses the AI Gateway (and its project budget), so the studio keeps its own ledger in
// `studio.ai_spend` (db/002_ai_spend.sql). Admission (reserveChatTurn in lib/chat-quota.ts,
// under the quota lock) reserves the turn's worst case (turnReserveUsd: every step at a large
// prompt and the output cap) so concurrent turns cannot all slip under the budget; the turn
// stops early rather than outgrow its reservation (TurnMeter.roomForAnotherCall) and then
// settles to its cost. A turn that never settles keeps its worst case counted. Months are UTC calendar months. The budget applies to every account,
// admins included (they only skip the per-account daily allowance).
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

/**
 * Whether a reservation still fits in the month (default: the smallest turn's, so "exhausted"
 * means no model fits). Keep in step with reserveChatTurn's SQL.
 */
export function budgetAllows(spentUsd: number, { budgetUsd, reserveUsd }: ReturnType<typeof budgetConfig>, reservationUsd = reserveUsd): boolean {
  return budgetUsd > 0 && spentUsd < budgetUsd && spentUsd + reservationUsd <= budgetUsd;
}

// The prompt size a turn is planned for. Bigger prompts are still metered at their real size;
// the turn just stops sooner (roomForAnotherCall).
const PLANNED_INPUT_TOKENS = 60_000;
// How much a prompt may grow between calls (the previous answer plus tool results and a render).
const PROMPT_GROWTH_TOKENS = 20_000;
// Anthropic bills cache writes at up to 2x input; others bill them as input or not at all.
const CACHE_WRITE_FACTOR = 2;

type Tokens = { input: number; cacheRead?: number; cacheWrite?: number; output: number };

function callUsd(modelId: string, t: Tokens): number {
  const price = modelPrice(modelId);
  const read = t.cacheRead ?? 0;
  const write = t.cacheWrite ?? 0;
  const fresh = Math.max(0, t.input - read - write);
  return (fresh * price.input + read * (price.cachedInput ?? price.input) + write * price.input * CACHE_WRITE_FACTOR + t.output * price.output) / 1e6;
}

/**
 * What a turn reserves at admission: its worst case at the planned prompt size (every step, full
 * output), and at least STUDIO_AI_TURN_RESERVE_USD.
 */
export function turnReserveUsd(modelId: string, maxSteps: number, maxOutputTokens: number): number {
  const worst = maxSteps * callUsd(modelId, { input: PLANNED_INPUT_TOKENS, output: maxOutputTokens });
  return Math.max(budgetConfig().reserveUsd, Math.ceil(worst * 100) / 100);
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

// For a model call whose usage never arrived (stopped or failed mid-stream): assume a large
// prompt and the full output cap, to err high.
const UNKNOWN_INPUT_TOKENS = 30_000;

type Call = { estimateUsd: number; generationId?: string };

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
    /** The turn's reservation; the turn stops before a call that could outgrow it. */
    private reservedUsd = Infinity,
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

  /**
   * The provider call threw. It may have been billed (an error mid-stream), so count it at its
   * cap: erring high is the safe direction for a budget.
   */
  fail() {
    if (this.open) this.calls.push({ estimateUsd: this.estimate({}) });
    this.open = false;
  }

  /** Whether one more call, at a grown prompt and the full output, still fits the reservation. */
  roomForAnotherCall(): boolean {
    const spent = this.snapshot().reduce((sum, c) => sum + c.estimateUsd, 0);
    const next = callUsd(this.modelId, { input: (this.lastInput ?? UNKNOWN_INPUT_TOKENS) + PROMPT_GROWTH_TOKENS, output: this.maxOutputTokens });
    return spent + next <= this.reservedUsd;
  }

  /** The calls so far, plus the cut-off call (if any) at its estimate. */
  snapshot(): Call[] {
    return this.open ? [...this.calls, { estimateUsd: this.estimate({}) }] : [...this.calls];
  }

  /** Unknown counts err high: the larger of the last prompt and UNKNOWN_INPUT_TOKENS, the output cap. */
  private estimate(t: Partial<Tokens>): number {
    return callUsd(this.modelId, {
      input: t.input ?? Math.max(this.lastInput ?? 0, UNKNOWN_INPUT_TOKENS),
      cacheRead: t.cacheRead,
      cacheWrite: t.cacheWrite,
      output: t.output ?? this.maxOutputTokens,
    });
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
