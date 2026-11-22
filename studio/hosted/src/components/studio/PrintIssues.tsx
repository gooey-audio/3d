"use client";
// The printability chip over the viewer and the panel it opens: each issue the build's check
// found, explained, with how to fix it. The viewer marks where they are while it is open.
import type { PrintIssue } from "./printability";

const CHECKS = "watertight, one piece, fits the bed, sits flat, no steep overhangs, no tall thin posts, walls thick enough";

export function PrintChip({ ok, count, open, onToggle }: { ok: boolean; count: number; open: boolean; onToggle: () => void }) {
  return (
    <button
      className={`chip-button ${ok ? "ok" : "warn"} ${open ? "on" : ""}`}
      onClick={onToggle}
      aria-expanded={open}
      title={ok ? "passes the print checks" : "what the issues are, and where"}
    >
      {ok ? "printable" : `${count} print issue${count === 1 ? "" : "s"}`} {open ? "▴" : "▾"}
    </button>
  );
}

export function PrintPanel({ ok, material, issues, onClose }: { ok: boolean; material: string; issues: PrintIssue[]; onClose: () => void }) {
  return (
    <div className="print-panel" role="dialog" aria-label="print check">
      <header>
        <b>Print check</b>
        <span className="muted">{material.toUpperCase()} · printed as modelled (Z up)</span>
        <button onClick={onClose} aria-label="close" title="close">
          ×
        </button>
      </header>
      {ok ? (
        <p className="muted">Passes every check: {CHECKS}.</p>
      ) : (
        <>
          <ol>
            {issues.map((i, k) => (
              <li key={k} title={i.raw}>
                <div className="title">
                  {i.title}
                  {i.shown && <span className="shown">{i.shown}</span>}
                </div>
                <p>{i.what}</p>
                {i.fix && (
                  <p>
                    <span className="muted">Fix: </span>
                    {i.fix}
                  </p>
                )}
              </li>
            ))}
          </ol>
          <p className="muted small">The agent sees these too: ask it in the chat to fix them.</p>
        </>
      )}
    </div>
  );
}
