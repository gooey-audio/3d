export const CHAT_LIMIT = "chat-limit";
export const MAX_CHAT_TEXT = 8_000;

/** `unlimited` (admins): no personal allowance, so `limit` and `remaining` are null. */
export type ChatQuota = {
  sharedLimitReached: boolean;
  /** The studio's monthly AI budget (lib/ai-spend.ts) has no room for another turn. */
  budgetExhausted: boolean;
  resetAt: string;
} & ({ unlimited: false; limit: number; remaining: number } | { unlimited: true; limit: null; remaining: null });
