export const CHAT_LIMIT = "chat-limit";
export const MAX_CHAT_TEXT = 8_000;

export type ChatQuota = {
  limit: number;
  remaining: number;
  sharedLimitReached: boolean;
  resetAt: string;
};
