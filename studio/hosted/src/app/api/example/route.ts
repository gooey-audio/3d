import { NextResponse } from "next/server";
import { EXAMPLE_PART, seedExample } from "@/lib/example";
import { noStore, route } from "@/lib/http";

// Settings' "Restore example part": writes the example even when the account deleted it (an
// existing `example` part is never replaced; `restored` is false then). Not under /api/parts,
// where a static segment would shadow the part named `example`.
export const POST = route(async () => {
  const restored = await seedExample({ force: true });
  return NextResponse.json({ name: EXAMPLE_PART, restored }, { headers: noStore });
});
