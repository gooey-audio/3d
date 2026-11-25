"use client";
// The parts screen: every part of the account as a card with a rendered thumbnail. A card
// opens the part in the studio; deleting a part lives here rather than in the studio header.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { UNITS_SETTING, useSetting } from "@/lib/settings";
import { fmtSize, type Units } from "@/lib/units";
import { api, errorMessage, type PartInfo } from "./api";
import { cachedThumbnail, thumbnail, type Thumb } from "./thumbnails";
import styles from "./Parts.module.css";

const studioUrl = (part: string) => `/?part=${encodeURIComponent(part)}`;

/** "5 min ago", or the date for anything older than a week. */
function ago(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function Parts({ accountEmail, isAdmin = false }: { accountEmail: string; isAdmin?: boolean }) {
  const router = useRouter();
  const [parts, setParts] = useState<PartInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  // New parts are written in the studio's units setting (per browser).
  const [units] = useSetting(UNITS_SETTING);

  useEffect(() => {
    api.parts().then(setParts, (e) => setError(errorMessage(e)));
  }, []);

  const createPart = async () => {
    const name = creating?.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await api.createPart(name, units); // the server validates the name
      router.push(studioUrl(name));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const deletePart = async (name: string) => {
    if (deleting || !confirm(`Delete ${name}.js, its scene, builds and conversation?`)) return;
    setDeleting(name);
    try {
      await api.deletePart(name);
      setParts((ps) => ps?.filter((p) => p.name !== name) ?? null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDeleting(null);
    }
  };

  const signOut = async () => {
    try {
      const { error } = await authClient.signOut();
      if (error) throw new Error(error.message ?? "Could not sign out.");
      location.replace("/login");
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="app">
      <header>
        <strong>gooey-studio</strong>
        <nav className="modes">
          <Link className="button" href="/">
            Studio
          </Link>
          <button className="on" aria-current="page">
            Parts
          </button>
        </nav>
        {creating === null ? (
          <button onClick={() => setCreating("")}>New part</button>
        ) : (
          <form
            className="new-part"
            onSubmit={(e) => {
              e.preventDefault();
              createPart();
            }}
          >
            <input
              autoFocus
              placeholder="name (letters, digits, - _ .)"
              value={creating}
              onChange={(e) => setCreating(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setCreating(null);
              }}
            />
            <button type="submit" disabled={!creating.trim() || busy}>
              Create
            </button>
            <button type="button" className="link" onClick={() => setCreating(null)}>
              cancel
            </button>
          </form>
        )}
        <span className="spacer" />
        <span className="muted small account-email" title={isAdmin ? `${accountEmail} (admin)` : accountEmail}>
          {accountEmail}
        </span>
        <button className="link muted" onClick={signOut}>
          sign out
        </button>
      </header>
      {error && (
        <div className="banner">
          {error}
          <button className="link" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}
      <main className={styles.screen}>
        {parts === null ? (
          !error && <p className="muted pad">Loading parts…</p>
        ) : parts.length === 0 ? (
          <div className={styles.empty}>
            <strong>No parts yet</strong>
            <p className="muted">Start from a starter model, then edit its script or ask the AI assistant to change it.</p>
            {creating === null && (
              <button className="primary" onClick={() => setCreating("")}>
                New part
              </button>
            )}
          </div>
        ) : (
          <ul className={styles.grid}>
            {parts.map((p) => (
              <PartCard
                key={`${p.name}@${p.mesh_ms}`}
                part={p}
                units={units}
                deleting={deleting === p.name}
                onDelete={() => deletePart(p.name)}
              />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function PartCard({ part, units, deleting, onDelete }: { part: PartInfo; units: Units; deleting: boolean; onDelete: () => void }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const [visible, setVisible] = useState(false);
  // undefined: not drawn yet; null: nothing to draw (no mesh, an empty one, or no WebGL).
  const [result, setResult] = useState<Thumb | null | "failed" | undefined>(() =>
    part.mesh ? cachedThumbnail(part.name, part.mesh_ms) : null,
  );

  // Drawn once the card comes near the viewport (cards are keyed by the mesh version).
  useEffect(() => {
    const el = ref.current;
    if (result !== undefined || visible || !el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setVisible(true);
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [result, visible]);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    thumbnail(part.name, part.mesh_ms).then(
      (t) => live && setResult(t),
      () => live && setResult("failed"),
    );
    return () => {
      live = false;
    };
  }, [visible, part.name, part.mesh_ms]);

  const thumb = result && result !== "failed" ? result : null;
  const placeholder = result === undefined ? null : result === "failed" ? "Preview failed" : part.mesh ? "No preview" : "No mesh yet";

  return (
    <li className={styles.card} aria-busy={deleting}>
      <Link ref={ref} className={styles.open} href={studioUrl(part.name)} prefetch={false} title={`Open ${part.name}.js in the studio`}>
        <div className={styles.thumb}>
          {thumb ? (
            // eslint-disable-next-line @next/next/no-img-element -- a data URL drawn in the browser
            <img src={thumb.url} alt={`${part.name} model`} />
          ) : (
            <span className={placeholder ? "muted small" : `muted small ${styles.loading}`}>{placeholder ?? "Rendering…"}</span>
          )}
        </div>
        <span className={styles.name}>{part.name}.js</span>
      </Link>
      <div className={styles.meta}>
        <span className="muted small" title={new Date(part.updated_ms).toLocaleString()}>
          {ago(part.updated_ms)}
          {thumb && ` · ${fmtSize(thumb.size, units)}`}
        </span>
        <button className="link" onClick={onDelete} disabled={deleting} title="Delete this part">
          {deleting ? "deleting…" : "delete"}
        </button>
      </div>
    </li>
  );
}
