"use client";
// Placeholder with the agreed interface; the agent-chat work replaces this file.
export type ChatPanelProps = {
  part: string;
  /** Called when a tool changed the part's script, scene or build: reload them. */
  onPartChanged: () => void;
  /** True while a turn runs (the editor is read-only then). */
  onBusyChange?: (busy: boolean) => void;
};

export function ChatPanel({ part }: ChatPanelProps) {
  return <div style={{ padding: 12, opacity: 0.6 }}>Agent chat for {part} (coming soon)</div>;
}
