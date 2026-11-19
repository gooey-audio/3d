"use client";
// The agent chat for one part: a useChat conversation against POST /api/chat, with a model
// picker, tool chips (diffs, render thumbnails), face-selection chips, stop/retry/clear and
// "revert to before this turn". Only the new user message is sent; the server keeps the history.
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart, type DynamicToolUIPart, type ToolUIPart } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MUTATING_TOOLS,
  selectionLabel,
  summarizeTool,
  TURN_LOCKED,
  type ChatMessage,
  type ChatRequest,
  type LookResult,
  type ScriptDiff,
} from "@/lib/agent-shared";
import type { FaceSelection } from "@/lib/selection";
import styles from "./ChatPanel.module.css";

export type ChatPanelProps = {
  part: string;
  /** Called when a tool changed the part's script, scene or build: reload them. */
  onPartChanged: () => void;
  /** True while a turn runs (the editor is read-only then). */
  onBusyChange?: (busy: boolean) => void;
  /** Faces picked in the viewer. They show as chips above the input and go with the next message. */
  selection?: FaceSelection[];
  /** Called to change the selection: a chip was removed, or the message was sent ([]). */
  onSelectionChange?: (s: FaceSelection[]) => void;
};

type ModelInfo = { id: string; label: string; vendor: string; via: string; vision?: boolean; available: boolean };
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

type LockHolder = { model?: string; started_ms?: number };

/** The 409 "another turn holds this part" response: its holder, or null for other errors. */
function lockOf(e: Error | undefined): LockHolder | null {
  if (!e) return null;
  try {
    const v = JSON.parse(e.message);
    if (v?.code === TURN_LOCKED) return (v.holder ?? {}) as LockHolder;
  } catch {
    /* not JSON */
  }
  return (e as { statusCode?: number }).statusCode === 409 ? {} : null;
}

export function ChatPanel(props: ChatPanelProps) {
  // A fresh chat per part: no state leaks from one part's conversation into another's.
  return <PartChat key={props.part} {...props} />;
}

function PartChat({ part, onPartChanged, onBusyChange, selection = [], onSelectionChange }: ChatPanelProps) {
  const [models, setModels] = useState<ModelList | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null);
  const changedRef = useRef(onPartChanged);
  const seen = useRef(new Set<string>());
  const end = useRef<HTMLDivElement>(null);
  // What the last send carried, to put back when the server refuses it (409).
  const pending = useRef<{ id?: string; text: string; selection: FaceSelection[] } | null>(null);
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
        // Only the new user message (the last one; after a regenerate, the one being re-run). The
        // server appends it to the stored history. The model rides along per request.
        prepareSendMessagesRequest: ({ messages, body, trigger }) => ({
          body: {
            part,
            model: String(body?.model ?? ""),
            message: messages[messages.length - 1],
            trigger: trigger === "regenerate-message" ? "regenerate-message" : "submit-message",
          } satisfies ChatRequest,
        }),
      }),
    [part],
  );

  const { messages, setMessages, sendMessage, regenerate, status, stop, error, clearError } = useChat<ChatMessage>({
    id: `chat:${part}`,
    transport,
    onFinish: () => changedRef.current(),
  });
  const busy = status === "submitted" || status === "streaming";

  const loadHistory = useCallback(
    (isLive: () => boolean = () => true) =>
      fetch(`/api/chat/history/${encodeURIComponent(part)}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then(({ messages: stored }: { messages: ChatMessage[] }) => {
          if (!isLive()) return;
          for (const m of stored) for (const p of m.parts) if (isToolUIPart(p)) seen.current.add(p.toolCallId);
          setMessages(stored);
        })
        .catch((e) => isLive() && setNote({ text: `could not load the conversation: ${e.message}`, err: true }))
        .finally(() => isLive() && setLoaded(true)),
    [part, setMessages],
  );

  useEffect(() => {
    let live = true;
    void loadHistory(() => live);
    return () => {
      live = false;
    };
  }, [loadHistory]);

  // Another tab's turn holds the part: take back the message that was not run, so it can be
  // sent again once that turn is over.
  const holder = lockOf(error);
  const locked = holder !== null;
  useEffect(() => {
    if (!locked || !pending.current) return;
    const p = pending.current;
    pending.current = null;
    setMessages((ms) => (ms.length && ms[ms.length - 1].role === "user" && (!p.id || ms[ms.length - 1].id === p.id) ? ms.slice(0, -1) : ms));
    setText((t) => t || p.text);
    if (p.selection.length) onSelectionChange?.(p.selection);
  }, [locked, setMessages, onSelectionChange]);

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
    const last = messages[messages.length - 1];
    if (pending.current && !pending.current.id && last?.role === "user") pending.current.id = last.id;
    if (status === "streaming") pending.current = null;
  }, [messages, status]);

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
    const sel = selection.map((s) => ({ ...s }));
    pending.current = { text: t, selection: sel };
    // The picked faces are stored on the user message (history shows what was pointed at) and
    // cleared once sent.
    void sendMessage({ text: t, ...(sel.length ? { metadata: { selection: sel } } : {}) }, { body: { model } });
    if (sel.length) onSelectionChange?.([]);
  };

  // Re-run the last user message (after an error or a stop). The server drops the old reply.
  const retry = () => {
    if (busy || !model) return;
    clearError();
    setNote(null);
    pending.current = null;
    void regenerate({ body: { model } });
  };

  const reload = () => {
    clearError();
    setNote(null);
    void loadHistory();
    changedRef.current();
  };

  const unselect = (i: number) => onSelectionChange?.(selection.filter((_, j) => j !== i));

  const clear = async () => {
    if (busy) return;
    const r = await fetch(`/api/chat/history/${encodeURIComponent(part)}`, { method: "DELETE" });
    if (!r.ok) {
      const v = await r.json().catch(() => ({}));
      return setNote({ text: `could not clear: ${v.error ?? `HTTP ${r.status}`}`, err: true });
    }
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
              {!!m.metadata?.selection?.length && (
                <div className={styles.sentChips}>
                  {m.metadata.selection.map((s, i) => (
                    <span key={i} className={styles.chip} title={chipTitle(s)}>
                      {selectionLabel(s)}
                    </span>
                  ))}
                </div>
              )}
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
                  {m.id === lastId && (m.metadata?.error || m.metadata?.stopped) && (
                    <button className={styles.link} disabled={busy} onClick={retry} title="run the last message again">
                      retry
                    </button>
                  )}
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
        {error && locked && (
          <div className={styles.locked}>
            <strong>This part is busy.</strong>{" "}
            {(() => {
              const who = [holder?.model && label(holder.model), holder?.started_ms && `started ${new Date(holder.started_ms).toLocaleTimeString()}`].filter(Boolean).join(", ");
              return `Another agent turn is running on it${who ? ` (${who})` : ""}, probably in another tab or window. Your message was not sent; send it again when that turn is done.`;
            })()}
            <div>
              <button className={styles.link} onClick={reload}>
                reload the conversation
              </button>
            </div>
          </div>
        )}
        {error && !locked && !lastMeta?.error && (
          <div className={styles.error}>
            {(() => {
              const msg = errorMessage(error);
              return model && !msg.startsWith(`${model}:`) ? `${label(model)}: ${msg}` : msg;
            })()}
            {messages[messages.length - 1]?.role === "user" && (
              <div>
                <button className={styles.link} onClick={retry}>
                  retry
                </button>
              </div>
            )}
          </div>
        )}
        {note && <div className={note.err ? styles.error : styles.muted}>{note.text}</div>}
        <div ref={end} />
      </div>

      {selection.length > 0 && (
        <div className={styles.chips}>
          <span className={styles.muted}>with</span>
          {selection.map((s, i) => (
            <span key={`${s.face}-${i}`} className={styles.chip} title={chipTitle(s)}>
              {selectionLabel(s)}
              {onSelectionChange && (
                <button className={styles.chipX} onClick={() => unselect(i)} aria-label={`remove ${selectionLabel(s)}`}>
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}

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

const fmtV = (v: number[]) => `[${v.map((x) => +x.toFixed(2)).join(", ")}]`;
const chipTitle = (s: FaceSelection) => `centre ${fmtV(s.center)}, normal ${fmtV(s.normal)}, build rev ${s.rev}`;

function ToolChip({ p }: { p: ToolUIPart | DynamicToolUIPart }) {
  const [open, setOpen] = useState(false);
  const name = getToolName(p);
  const output = p.state === "output-available" ? p.output : undefined;
  const s = summarizeTool(name, p.input, output, p.state === "output-error" ? p.errorText : undefined);
  const o = (output ?? {}) as { script_diff?: ScriptDiff } & Partial<LookResult>;
  const diff = o.script_diff;
  const look = name === "look_at_part" && o.ok === true && typeof o.image === "string" ? (o as LookResult) : null;
  return (
    <div className={`${styles.tool} ${styles[s.state]}`}>
      <button className={styles.toolHead} onClick={() => setOpen(!open)}>
        <span className={styles.toolIcon}>{s.state === "run" ? "◌" : s.state === "ok" ? "✓" : "✗"}</span>
        <code>{name}</code>
        <span className={styles.toolSum}>{s.text}</span>
      </button>
      {look && (
        <a className={styles.thumb} href={look.image} target="_blank" rel="noreferrer" title={`render ${look.job} (open full size)`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a private, auth-gated API image */}
          <img src={look.image} alt={`render of ${look.views.map(String).join(", ")}`} loading="lazy" />
        </a>
      )}
      {open &&
        (diff ? (
          <div className={styles.toolBody}>
            {diff.diff ? <DiffView diff={diff.diff} /> : <div className={styles.muted}>no change to the script</div>}
            <pre className={styles.toolResult}>{"→ "}{JSON.stringify(withoutDiff(output), null, 2)}</pre>
          </div>
        ) : (
          <pre className={styles.toolBody}>
            {JSON.stringify(p.input, null, 2)}
            {"\n→ "}
            {p.state === "output-available" ? JSON.stringify(p.output, null, 2) : p.state === "output-error" ? p.errorText : "…"}
          </pre>
        ))}
    </div>
  );
}

function withoutDiff(output: unknown) {
  const rest = { ...((output ?? {}) as Record<string, unknown>) };
  delete rest.script_diff;
  return rest;
}

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className={styles.diff}>
      {diff.split("\n").map((l, i) => {
        const c = l.startsWith("@@") ? styles.dHunk : l.startsWith("+++") || l.startsWith("---") ? styles.dFile : l[0] === "+" ? styles.dAdd : l[0] === "-" ? styles.dDel : undefined;
        return (
          <span key={i} className={c}>
            {l}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}
