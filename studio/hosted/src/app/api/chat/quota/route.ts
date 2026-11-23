import { chatQuota } from "@/lib/chat-quota";
import { route } from "@/lib/http";

export const GET = route(async (_req, _ctx, accountId) => Response.json(await chatQuota(accountId)));
