import "server-only";
import { neon } from "@neondatabase/serverless";
import { fail } from "./http";
import { budgetAllows, budgetConfig } from "./ai-spend";
import type { ChatQuota } from "./chat-quota-shared";

function dailyLimit(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const count = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(count)) throw new Error(`Invalid ${name}`);
  return count;
}

function config() {
  const url = process.env.DATABASE_URL;
  if (!url) throw fail(503, "AI chat is temporarily unavailable.");
  return {
    sql: neon(url),
    limit: dailyLimit("STUDIO_AI_DAILY_TURNS", 5),
    globalLimit: dailyLimit("STUDIO_AI_GLOBAL_DAILY_TURNS", 40),
    budget: budgetConfig(),
  };
}

type Config = ReturnType<typeof config>;
type Usage = { personal: number; total: number; spent: number; reset_at: string };

function quota(usage: Usage, { limit, globalLimit, budget }: Config, unlimited: boolean): ChatQuota {
  const shared = {
    sharedLimitReached: usage.total >= globalLimit,
    budgetExhausted: !budgetAllows(usage.spent, budget),
    resetAt: new Date(usage.reset_at).toISOString(),
  };
  return unlimited
    ? { ...shared, unlimited, limit: null, remaining: null }
    : { ...shared, unlimited, limit, remaining: Math.max(0, limit - usage.personal) };
}

/** The "email us for more AI access" link shown when the allowance runs out (STUDIO_AI_INTEREST_EMAIL). */
export function aiInterestUrl(): string | undefined {
  const email = process.env.STUDIO_AI_INTEREST_EMAIL?.trim();
  return email ? `mailto:${encodeURIComponent(email).replace("%40", "@")}?subject=Gooey%20Studio%20AI%20access` : undefined;
}

/** `unlimited` skips the personal allowance; the turns still count toward the shared limit and budget. */
export async function chatQuota(accountId: string, { unlimited = false } = {}): Promise<ChatQuota> {
  const cfg = config();
  const [usage] = await cfg.sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE account_id = ${accountId})::int AS personal,
           (SELECT coalesce(sum(coalesce(cost_usd, reserved_usd)), 0)::float8
            FROM studio.ai_spend
            WHERE month = date_trunc('month', now() AT TIME ZONE 'UTC')::date) AS spent,
           (((now() AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC') AS reset_at
    FROM studio.chat_turns
    WHERE day = (now() AT TIME ZONE 'UTC')::date
  `;
  return quota(usage as Usage, cfg, unlimited);
}

/**
 * Hold the lock until commit, then count and insert using a fresh READ COMMITTED snapshot. An
 * admitted turn also reserves its share of the monthly AI budget (lib/ai-spend.ts); `spendId`
 * is the ledger row to settle when the turn ends. `unlimited` only skips the personal allowance:
 * the shared daily limit and the monthly budget still apply.
 */
export async function reserveChatTurn(
  accountId: string,
  model: string,
  { unlimited = false, reserveUsd }: { unlimited?: boolean; reserveUsd: number },
): Promise<{ accepted: boolean; quota: ChatQuota; spendId: string | null; budgetTooLow: boolean }> {
  const cfg = config();
  const { sql, limit, globalLimit } = cfg;
  const { budgetUsd } = cfg.budget;
  const [, [usage]] = await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(hashtext('gooey-studio.chat-quota'))`,
    sql`
      WITH today AS (
        SELECT (statement_timestamp() AT TIME ZONE 'UTC')::date AS day
      ), usage AS (
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE account_id = ${accountId})::int AS personal
        FROM studio.chat_turns
        WHERE day = (SELECT day FROM today)
      ), spend AS (
        SELECT date_trunc('month', day::timestamp)::date AS month,
               (SELECT coalesce(sum(coalesce(cost_usd, reserved_usd)), 0)::float8
                FROM studio.ai_spend
                WHERE month = date_trunc('month', day::timestamp)::date) AS spent
        FROM today
      ), admit AS (
        -- Same rule as budgetAllows().
        SELECT (${unlimited}::boolean OR personal < ${limit}) AND total < ${globalLimit}
               AND ${budgetUsd}::float8 > 0 AND spent < ${budgetUsd}::float8
               AND spent + ${reserveUsd}::float8 <= ${budgetUsd}::float8 AS ok
        FROM usage, spend
      ), reserved AS (
        INSERT INTO studio.chat_turns (day, account_id)
        SELECT day, ${accountId} FROM today, admit
        WHERE ok
        RETURNING 1
      ), ledger AS (
        INSERT INTO studio.ai_spend (month, account_id, model, reserved_usd)
        SELECT month, ${accountId}, ${model}, ${reserveUsd}::numeric FROM spend, admit
        WHERE ok
        RETURNING id
      )
      SELECT personal + (SELECT count(*)::int FROM reserved) AS personal,
             total + (SELECT count(*)::int FROM reserved) AS total,
             spent + CASE WHEN ok THEN ${reserveUsd}::float8 ELSE 0 END AS spent,
             EXISTS (SELECT 1 FROM reserved) AS accepted,
             (SELECT id::text FROM ledger) AS spend_id,
             ((day + 1)::timestamp AT TIME ZONE 'UTC') AS reset_at
      FROM today, usage, spend, admit
    `,
  ], { isolationLevel: "ReadCommitted" });
  return {
    accepted: usage.accepted,
    quota: quota(usage as Usage, cfg, unlimited),
    spendId: usage.spend_id ?? null,
    // Turned away by the budget for this model's reservation (the reported spend includes it when accepted).
    budgetTooLow: !usage.accepted && !budgetAllows(usage.spent, cfg.budget, reserveUsd),
  };
}
