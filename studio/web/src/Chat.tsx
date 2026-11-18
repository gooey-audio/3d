import { useEffect, useRef, useState } from "react";
import type { StoredTurn } from "./api";

export type Item =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; id: string; name: string; args: any; result?: any };

export type TurnView = { id: string; user: string; items: Item[]; done: boolean; error?: string | null };

/** A stored turn (API messages) as display items. */
export function fromStored(t: StoredTurn): TurnView {
  const items: Item[] = [];
  for (const m of t.messages.slice(1)) {
    if (m.role === "assistant") {
      if (m.content) items.push({ kind: "text", text: m.content });
      for (const c of m.tool_calls ?? []) {
        let args: any = c.function.arguments;
        try {
          args = JSON.parse(args);
        } catch {
          /* keep the raw text */
        }
        items.push({ kind: "tool", id: c.id, name: c.function.name, args });
      }
    } else if (m.role === "tool") {
      const it = items.find((i) => i.kind === "tool" && i.id === m.tool_call_id) as Extract<Item, { kind: "tool" }>;
      if (it) {
        try {
          it.result = JSON.parse(m.content ?? "null");
        } catch {
          it.result = m.content;
        }
      }
    }
  }
  return { id: t.id, user: t.user, items, done: t.done, error: t.error };
}

/** Applies one `agent` event to the turn list. */
export function applyAgentEvent(turns: TurnView[], e: any): TurnView[] {
  if (e.kind === "start") {
    return [...turns.filter((t) => t.id !== e.turn), { id: e.turn, user: e.user, items: [], done: false }];
  }
  return turns.map((t) => {
    if (t.id !== e.turn) return t;
    const items = [...t.items];
    const last = items[items.length - 1];
    switch (e.kind) {
      case "delta":
      case "reasoning": {
        const kind = e.kind === "delta" ? "text" : "reasoning";
        if (last && last.kind === kind) items[items.length - 1] = { ...last, text: last.text + e.text };
        else items.push({ kind, text: e.text });
        break;
      }
      case "tool_call":
        items.push({ kind: "tool", id: e.id, name: e.name, args: e.args });
        break;
      case "tool_result": {
        const i = items.findIndex((x) => x.kind === "tool" && x.id === e.id);
        if (i >= 0) items[i] = { ...(items[i] as any), result: e.result };
        break;
      }
      case "done":
        return { ...t, items, done: true, error: e.error };
    }
    return { ...t, items };
  });
}

function toolSummary(it: Extract<Item, { kind: "tool" }>): { text: string; state: "run" | "ok" | "err" } {
  const r = it.result;
  if (r === undefined) return { text: "…", state: "run" };
  const build = r.report || r.error?.kind ? r : r.build;
  if (r.ok === false && typeof r.error === "string") return { text: r.error, state: "err" };
  if (build && build.ok === false && build.error) {
    const e = build.error;
    return { text: `${e.kind}${e.line ? ` at line ${e.line}` : ""}: ${e.message}`, state: "err" };
  }
  if (build?.report) {
    const s = build.report.size_mm.map((x: number) => x.toFixed(1)).join(" × ");
    return { text: `built ${s} mm in ${build.seconds}s${build.note ? " (unchanged)" : ""}`, state: "ok" };
  }
  if (it.name === "update_scene") return { text: Object.keys(it.args?.patch ?? {}).join(", ") || "ok", state: "ok" };
  return { text: "ok", state: "ok" };
}

function Tool({ it }: { it: Extract<Item, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const s = toolSummary(it);
  return (
    <div className={`tool ${s.state}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="tool-icon">{s.state === "run" ? "◌" : s.state === "ok" ? "✓" : "✗"}</span>
        <code>{it.name}</code>
        <span className="tool-sum">{s.text}</span>
      </button>
      {open && (
        <pre className="tool-body">
          {JSON.stringify(it.args, null, 2)}
          {"\n→ "}
          {JSON.stringify(it.result, null, 2)}
        </pre>
      )}
    </div>
  );
}

type Props = {
  turns: TurnView[];
  running: boolean;
  enabled: boolean;
  model: string | null;
  onSend: (text: string) => void;
  onStop: () => void;
  onRevert: (turn: string) => void;
  onClear: () => void;
};

export function Chat({ turns, running, enabled, model, onSend, onStop, onRevert, onClear }: Props) {
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Braces: newer browsers return a promise from scrollIntoView, which React would call as a cleanup.
    end.current?.scrollIntoView({ block: "end" });
  }, [turns]);
  const send = () => {
    if (!text.trim() || running) return;
    onSend(text.trim());
    setText("");
  };
  return (
    <div className="chat">
      <div className="chat-head">
        <span>Agent</span>
        <span className="muted">{model ?? "off"}</span>
        {turns.length > 0 && !running && (
          <button className="link" onClick={onClear}>
            clear
          </button>
        )}
      </div>
      <div className="chat-log">
        {!enabled && (
          <p className="muted pad">
            The agent is off. Set <code>DEEPSEEK_API_KEY</code> and restart <code>gooey-studio</code>.
          </p>
        )}
        {enabled && turns.length === 0 && (
          <p className="muted pad">
            Ask for a change: "add four M3 holes 6 mm from the corners", "fillet the top edges 2 mm", "make it brushed
            aluminium on a dark background".
          </p>
        )}
        {turns.map((t) => (
          <div key={t.id} className="turn">
            <div className="user">{t.user}</div>
            {t.items.map((it, i) =>
              it.kind === "tool" ? (
                <Tool key={it.id + i} it={it} />
              ) : it.kind === "reasoning" ? (
                <details key={i} className="reasoning">
                  <summary>thinking</summary>
                  {it.text}
                </details>
              ) : (
                <div key={i} className="assistant">
                  {it.text}
                </div>
              ),
            )}
            {!t.done && <div className="muted small">working…</div>}
            {t.error && <div className="turn-error">{t.error}</div>}
            {t.done && (
              <button className="link small" onClick={() => onRevert(t.id)} disabled={running}>
                revert to before this turn
              </button>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="chat-input">
        <textarea
          value={text}
          placeholder={enabled ? "Describe a change… (Enter to send, Shift+Enter for a new line)" : "agent off"}
          disabled={!enabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {running ? (
          <button onClick={onStop}>Stop</button>
        ) : (
          <button onClick={send} disabled={!enabled || !text.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
