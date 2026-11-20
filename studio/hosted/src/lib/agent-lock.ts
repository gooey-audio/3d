// A per-part agent turn lock in Blob (`parts/<part>/turn.json`), so two tabs cannot run turns on
// the same part at once. Best effort: Blob has no compare-and-swap, so acquire writes, waits a
// moment and reads back; of two racing writers the one whose id survives wins. A lock that is
// not refreshed expires (a crashed function cannot hold a part forever). Server-only.
import "server-only";
import * as store from "./store";
import type { TurnLock } from "./store";

/** A turn holds the lock this long past its last refresh (a turn is at most 5 min). */
export const LOCK_MS = 6 * 60_000;

export type Acquired = { ok: true; lock: TurnLock } | { ok: false; holder: TurnLock };

const live = (t: TurnLock | null, now = Date.now()): t is TurnLock => !!t && t.expires_ms > now;

export async function holder(part: string): Promise<TurnLock | null> {
  const t = await store.readTurn(part);
  return live(t) ? t : null;
}

export async function acquire(part: string, model: string): Promise<Acquired> {
  const cur = await store.readTurn(part);
  if (live(cur)) return { ok: false, holder: cur };
  const now = Date.now();
  const lock: TurnLock = { id: `t${now}-${Math.random().toString(36).slice(2, 8)}`, model, started_ms: now, expires_ms: now + LOCK_MS };
  await store.writeTurn(part, lock);
  await new Promise((r) => setTimeout(r, 150));
  const back = await store.readTurn(part);
  if (back && back.id !== lock.id && live(back)) return { ok: false, holder: back };
  return { ok: true, lock };
}

/** Pushes the expiry out (after each step). Skipped when another turn took over meanwhile. */
export async function refresh(part: string, lock: TurnLock): Promise<void> {
  const cur = await store.readTurn(part);
  if (cur && cur.id !== lock.id) return;
  lock.expires_ms = Date.now() + LOCK_MS;
  await store.writeTurn(part, lock);
}

export async function release(part: string, lock: TurnLock): Promise<void> {
  const cur = await store.readTurn(part);
  if (!cur || cur.id === lock.id) await store.deleteTurn(part);
}

/** The 409 body for a part another turn holds. */
export function lockedBody(t: TurnLock, label: string) {
  const started = new Date(t.started_ms).toISOString();
  return {
    error: `another agent turn is running on this part (${label}, started ${started}), probably in another tab or window. Wait for it to finish, then reload the conversation.`,
    code: "turn-locked" as const,
    holder: { model: t.model, started_ms: t.started_ms, expires_ms: t.expires_ms },
  };
}
