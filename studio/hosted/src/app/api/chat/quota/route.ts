import { chatQuota } from "@/lib/chat-quota";
import { route } from "@/lib/http";

export const GET = route(async (_req, _ctx, accountId, { admin }) => {
  return Response.json(await chatQuota(accountId, { unlimited: admin }));
});
