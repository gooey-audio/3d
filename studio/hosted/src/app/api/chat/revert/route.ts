// POST /api/chat/revert { part, checkpoint }: restores the script and scene from before a turn
// (store.restore) and rebuilds. Returns `{ ok: true, build }` (the new BuildSummary); 409 while
// an agent turn runs on the part.
import * as lock from "@/lib/agent-lock";
import { modelLabel } from "@/lib/models";
import { buildPart } from "@/lib/parts";
import * as store from "@/lib/store";

export const maxDuration = 120;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { part?: unknown; checkpoint?: unknown } | null;
  const part = body?.part;
  const checkpoint = body?.checkpoint;
  if (typeof part !== "string" || !store.validPart(part)) return Response.json({ error: "bad or missing `part`" }, { status: 400 });
  if (typeof checkpoint !== "string" || !/^\d+$/.test(checkpoint)) return Response.json({ error: "bad or missing `checkpoint`" }, { status: 400 });
  const t = await lock.holder(part);
  if (t) return Response.json(lock.lockedBody(t, modelLabel(t.model)), { status: 409 });
  try {
    await store.restore(part, checkpoint);
  } catch (e) {
    const status = e instanceof store.StoreError ? 404 : 500;
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
  const build = await buildPart(part);
  return Response.json({ ok: true, build });
}
