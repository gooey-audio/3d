"use client";
// The agent chat for one part: a useChat conversation against POST /api/chat, with a model
// picker, tool chips, stop/clear and "revert to before this turn".
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart, type DynamicToolUIPart, type ToolUIPart } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MUTATING_TOOLS, summarizeTool, type ChatMessage, type ChatRequest } from "@/lib/agent-shared";
import styles from "./ChatPanel.module.css";

export type ChatPanelProps = {
  part: string;
  /** Called when a tool changed the part's script, scene or build: reload them. */
  onPartChanged: () => void;
  /** True while a turn runs (the editor is read-only then). */
  onBusyChange?: (busy: boolean) => void;
};

type ModelInfo = { id: string; label: string; vendor: string; via: string; available: boolean };
type ModelList = { default: string; models: ModelInfo[] };

const MODEL_KEY = "gooey-studio.agent-model";
let modelsPromise: Promise<ModelList> | null = null;

function loadModels(): Promise<ModelList> {
  modelsPromise ??= fetch("/api/chat/models")
    .then((r) => (r.ok ? (r.json() as Promise<ModelList>) : Promise.reject(new Error(`models: HTTP ${r.status}`))))
    .catch((e) => {
      modelsPromise = null;
      throw e;
    });
  return modelsPromise;
}

/** The error body of a failed request is `{"error": "..."}`; streamed errors are plain text. */
function errorMessage(e: Error): string {
  try {
    const v = JSON.parse(e.message);
    if (v && typeof v.error === "string") return v.error;
  } catch {
    /* plain text */
  }
  return e.message;
}

export function ChatPanel(props: ChatPanelProps) {
  // A fresh chat per part: no state leaks from one part's conversation into another's.
  return <PartChat key={props.part} {...props} />;
}

function PartChat({ part, onPartChanged, onBusyChange }: ChatPanelProps) {
  const [models, setModels] = useState<ModelList | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null);
  const changedRef = useRef(onPartChanged);
  const seen = useRef(new Set<string>());
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    changedRef.current = onPartChanged;
  }, [onPartChanged]);

  useEffect(() => {
    let live = true;
    loadModels()
      .then((list) => {
        if (!live) return;
        setModels(list);
        const stored = localStorage.getItem(MODEL_KEY);
        const pick = list.models.some((m) => m.id === stored) ? stored! : list.default;
        setModel(pick);
      })
      .catch((e) => live && setNote({ text: `could not load the models: ${e.message}`, err: true }));
    return () => {
      live = false;
    };
  }, []);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<ChatMessage>({
        api: "/api/chat",
        // The model rides along per request (sendMessage's `body`).
        prepareSendMessagesRequest: ({ messages, body }) => ({
          body: { part, model: String(body?.model ?? ""), messages } satisfies ChatRequest,
        }),
      }),
    [part],
  );

  const { messages, setMessages, sendMessage, status, stop, error, clearError } = useChat<ChatMessage>({
    id: `chat:${part}`,
    transport,
    onFinish: () => changedRef.current(),
  });
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    let live = true;
    fetch(`/api/chat/history/${encodeURIComponent(part)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(({ messages: stored }: { messages: ChatMessage[] }) => {
        if (!live) return;
        for (const m of stored) for (const p of m.parts) if (isToolUIPart(p)) seen.current.add(p.toolCallId);
        setMessages(stored);
      })
      .catch((e) => live && setNote({ text: `could not load the conversation: ${e.message}`, err: true }))
      .finally(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, [part, setMessages]);

  // Reload the part as soon as a tool that changed it reports back.
  useEffect(() => {
    let changed = false;
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const p of m.parts) {
        if (!isToolUIPart(p) || seen.current.has(p.toolCallId)) continue;
        if (p.state !== "output-available" && p.state !== "output-error") continue;
        seen.current.add(p.toolCallId);
        if (MUTATING_TOOLS.has(getToolName(p))) changed = true;
      }
    }
    if (changed) changedRef.current();
  }, [messages]);

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages, status, note, error]);

  const pickModel = (id: string) => {
    setModel(id);
    localStorage.setItem(MODEL_KEY, id);
  };

  const send = () => {
    const t = text.trim();
    if (!t || busy || !model || !loaded) return;
    clearError();
    setNote(null);
    setText("");
    void sendMessage({ text: t }, { body: { model } });
  };

  const clear = async () => {
    if (busy) return;
    const r = await fetch(`/api/chat/history/${encodeURIComponent(part)}`, { method: "DELETE" });
    if (!r.ok) return setNote({ text: `could not clear: HTTP ${r.status}`, err: true });
    clearError();
    setNote(null);
    setMessages([]);
  };

  const revert = useCallback(
    async (checkpoint: string) => {
      setNote({ text: "reverting…" });
      const r = await fetch("/api/chat/revert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ part, checkpoint }),
      });
      const v = await r.json().catch(() => ({}));
      if (!r.ok) setNote({ text: `revert failed: ${v.error ?? `HTTP ${r.status}`}`, err: true });
      else setNote({ text: `reverted to ${new Date(Number(checkpoint)).toLocaleTimeString()}${v.build?.ok === false ? " (that version does not build)" : ""}` });
      changedRef.current();
    },
    [part],
  );

  const label = (id?: string) => models?.models.find((m) => m.id === id)?.label ?? id ?? "";
  const lastId = messages[messages.length - 1]?.id;
  const lastMeta = messages[messages.length - 1]?.metadata;
  const vendors = useMemo(() => [...new Set(models?.models.map((m) => m.vendor) ?? [])], [models]);

  return (
    <div className={styles.chat}>
      <div className={styles.head}>
        <span className={styles.title}>Agent</span>
        <select className={styles.picker} value={model ?? ""} onChange={(e) => pickModel(e.target.value)} disabled={!models || busy} title="model">
          {!models && <option value="">loading…</option>}
          {vendors.map((v) => (
            <optgroup key={v} label={v}>
              {models!.models
                .filter((m) => m.vendor === v)
                .map((m) => (
                  <option key={m.id} value={m.id} disabled={!m.available}>
                    {m.label}
                    {m.available ? "" : " (no credentials)"}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        {messages.length > 0 && !busy && (
          <button className={styles.link} onClick={clear}>
            clear
          </button>
        )}
      </div>

      <div className={styles.log}>
        {loaded && messages.length === 0 && (
          <p className={styles.muted}>
            Ask for a change: &ldquo;add four M3 holes 6 mm from the corners&rdquo;, &ldquo;fillet the top edges 2 mm&rdquo;,
            &ldquo;make it brushed aluminium on a dark background&rdquo;.
          </p>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className={styles.user}>
              {m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}
            </div>
          ) : m.role === "assistant" ? (
            <div key={m.id} className={styles.turn}>
              {m.parts.map((p, i) => {
                if (p.type === "text") return p.text.trim() ? <div key={i} className={styles.assistant}>{p.text}</div> : null;
                if (p.type === "reasoning")
                  return p.text.trim() ? (
                    <details key={i} className={styles.reasoning}>
                      <summary>thinking</summary>
                      {p.text}
                    </details>
                  ) : null;
                if (isToolUIPart(p)) return <ToolChip key={p.toolCallId} p={p} />;
                return null;
              })}
              {m.metadata?.error && <div className={styles.error}>{m.metadata.error}</div>}
              {m.metadata?.stopped && !m.metadata?.error && <div className={styles.muted}>stopped</div>}
              {m.metadata?.finishReason === "tool-calls" && !m.metadata?.stopped && (
                <div className={styles.muted}>stopped at the step limit</div>
              )}
              {!(busy && m.id === lastId) && (
                <div className={styles.foot}>
                  <span>{label(m.metadata?.model)}</span>
                  {m.metadata?.checkpoint && (
                    <button className={styles.link} disabled={busy} onClick={() => revert(m.metadata!.checkpoint!)}>
                      revert to before this turn
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : null,
        )}
        {busy && <div className={styles.muted}>working…</div>}
        {error && !lastMeta?.error && (
          <div className={styles.error}>
            {(() => {
              const msg = errorMessage(error);
              return model && !msg.startsWith(`${model}:`) ? `${label(model)}: ${msg}` : msg;
            })()}
          </div>
        )}
        {note && <div className={note.err ? styles.error : styles.muted}>{note.text}</div>}
        <div ref={end} />
      </div>

      <div className={styles.input}>
        <textarea
          value={text}
          placeholder="Describe a change… (Enter to send, Shift+Enter for a new line)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {busy ? (
          <button className={styles.button} onClick={() => stop()}>
            Stop
          </button>
        ) : (
          <button className={styles.button} onClick={send} disabled={!text.trim() || !model || !loaded}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}

function ToolChip({ p }: { p: ToolUIPart | DynamicToolUIPart }) {
  const [open, setOpen] = useState(false);
  const name = getToolName(p);
  const s = summarizeTool(name, p.input, p.state === "output-available" ? p.output : undefined, p.state === "output-error" ? p.errorText : undefined);
  return (
    <div className={`${styles.tool} ${styles[s.state]}`}>
      <button className={styles.toolHead} onClick={() => setOpen(!open)}>
        <span className={styles.toolIcon}>{s.state === "run" ? "◌" : s.state === "ok" ? "✓" : "✗"}</span>
        <code>{name}</code>
        <span className={styles.toolSum}>{s.text}</span>
      </button>
      {open && (
        <pre className={styles.toolBody}>
          {JSON.stringify(p.input, null, 2)}
          {"\n→ "}
          {p.state === "output-available" ? JSON.stringify(p.output, null, 2) : p.state === "output-error" ? p.errorText : "…"}
        </pre>
      )}
    </div>
  );
}
