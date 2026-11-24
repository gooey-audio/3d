// GET /api/chat/models: the model picker's list, `{ default, models: [{id, label, vendor, via, available}] }`.
import { route } from "@/lib/http";
import { listModels } from "@/lib/models";

export const GET = route(async () => Response.json(listModels()));
