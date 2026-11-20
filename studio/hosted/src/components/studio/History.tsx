"use client";
// The script history menu in the editor header: the part's checkpoints (saved before agent
// turns and before restores), a preview of each, and restore.
import { useEffect, useRef, useState } from "react";
import { api, errorMessage, type Checkpoint, type CheckpointInfo } from "./api";

type Props = {
  part: string;
  /** The editor's current text, to mark a checkpoint that matches it. */
  current: string;
  disabled: boolean;
  onRestore: (id: string) => Promise<void>;
};

export function History({ part, current, disabled, onRestore }: Props) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<CheckpointInfo[] | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [preview, setPreview] = useState<Checkpoint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cache = useRef(new Map<string, Checkpoint>());
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const want = useRef<string | null>(null);

  const show = async (id: string) => {
    want.current = id;
    setPick(id);
    setError(null);
    const hit = cache.current.get(`${part}/${id}`);
    if (hit) return setPreview(hit);
    setPreview(null);
    try {
      const c = await api.checkpoint(part, id);
      cache.current.set(`${part}/${id}`, c);
      if (want.current === id) setPreview(c);
    } catch (e) {
      if (want.current === id) setError(errorMessage(e));
    }
  };

  const toggle = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    setList(null);
    setPick(null);
    setPreview(null);
    setError(null);
    try {
      const l = await api.history(part);
      setList(l);
      if (l.length) show(l[0].id);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  // Close on Escape and on clicks outside.
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", down, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", down, true);
    };
  }, [open]);

  // A different part: close (its checkpoints are another list).
  const [shownPart, setShownPart] = useState(part);
  if (shownPart !== part) {
    setShownPart(part);
    setOpen(false);
  }

  const restore = async () => {
    if (!pick) return;
    setBusy(true);
    setError(null);
    try {
      await onRestore(pick);
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button ref={button} className={`history-btn ${open ? "on" : ""}`} onClick={toggle} title="Script checkpoints: preview and restore">
        history
      </button>
      {open && (
        <div className="history" ref={box}>
          <ul>
            {list === null && !error && <li className="empty-note">loading…</li>}
            {list?.length === 0 && <li className="empty-note">No checkpoints yet. The agent saves one before each turn.</li>}
            {list?.map((c) => (
              <li key={c.id}>
                <button className={pick === c.id ? "on" : ""} onClick={() => show(c.id)}>
                  <span>{stamp(c.at)}</span>
                  <span className="small">{ago(c.at)}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="preview">
            <div className="preview-head">
              {pick ? <span>{stamp(Number(pick))}</span> : <span className="muted">pick a checkpoint</span>}
              {preview && <span className="muted small">{preview.script === current ? "same as the editor" : `${lines(preview.script)} lines`}</span>}
              <span style={{ flex: 1 }} />
              {error && <span className="error small">{error}</span>}
              <button disabled={!preview || busy || disabled || preview.script === null} onClick={restore} title="Restore this script and scene and rebuild (the current one is saved as a checkpoint first)">
                {busy ? "restoring…" : "restore"}
              </button>
            </div>
            <pre>{preview ? (preview.script ?? "(no script)") : pick && !error ? "loading…" : ""}</pre>
          </div>
        </div>
      )}
    </>
  );
}

const lines = (s: string | null) => (s ? s.split("\n").length : 0);

function stamp(ms: number): string {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return today ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
