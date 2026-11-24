import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

const workspace = new AsyncLocalStorage<string>();

export function workspacePrefix(accountId: string): string {
  const id = createHash("sha256").update(accountId).digest("hex");
  return `3d-studio/accounts/${id}/`;
}

export function inWorkspace<T>(accountId: string, run: () => T): T {
  return workspace.run(workspacePrefix(accountId), run);
}

export function currentWorkspace(): string {
  const prefix = workspace.getStore();
  if (!prefix) throw new Error("Studio storage requires an authenticated workspace");
  return prefix;
}
