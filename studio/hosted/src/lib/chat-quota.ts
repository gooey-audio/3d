import "server-only";
import { neon } from "@neondatabase/serverless";
import { fail } from "./http";
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
  };
}

type Usage = { personal: number; total: number; reset_at: string };

function quota(usage: Usage, limit: number, globalLimit: number): ChatQuota {
  return {
    limit,
    remaining: Math.max(0, limit - usage.personal),
    sharedLimitReached: usage.total >= globalLimit,
    resetAt: new Date(usage.reset_at).toISOString(),
  };
}

export async function chatQuota(accountId: string): Promise<ChatQuota> {
  const { sql, limit, globalLimit } = config();
  const [usage] = await sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE account_id = ${accountId})::int AS personal,
           (((now() AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC') AS reset_at
    FROM studio.chat_turns
    WHERE day = (now() AT TIME ZONE 'UTC')::date
  `;
  return quota(usage as Usage, limit, globalLimit);
}

/** Hold the lock until commit, then count and insert using a fresh READ COMMITTED snapshot. */
export async function reserveChatTurn(accountId: string): Promise<{ accepted: boolean; quota: ChatQuota }> {
  const { sql, limit, globalLimit } = config();
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
      ), reserved AS (
        INSERT INTO studio.chat_turns (day, account_id)
        SELECT day, ${accountId} FROM today, usage
        WHERE personal < ${limit} AND total < ${globalLimit}
        RETURNING 1
      )
      SELECT personal + (SELECT count(*)::int FROM reserved) AS personal,
             total + (SELECT count(*)::int FROM reserved) AS total,
             EXISTS (SELECT 1 FROM reserved) AS accepted,
             ((day + 1)::timestamp AT TIME ZONE 'UTC') AS reset_at
      FROM today, usage
    `,
  ], { isolationLevel: "ReadCommitted" });
  return { accepted: usage.accepted, quota: quota(usage as Usage, limit, globalLimit) };
}
