// GET /api/chat/models: the model picker's list, `{ default, models: [{id, label, vendor, via, available}] }`.
import { connection } from "next/server";
import { listModels } from "@/lib/models";

export async function GET() {
  await connection(); // availability depends on the runtime environment, not the build's
  return Response.json(listModels());
}
