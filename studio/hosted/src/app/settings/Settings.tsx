"use client";
// The settings page: account, per-browser preferences (lib/settings.ts, shared with the studio
// and the chat), today's AI allowance and, for admins, an admin section.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import type { ChatQuota } from "@/lib/chat-quota-shared";
import type { ModelInfo } from "@/lib/models";
import { MODEL_SETTING, UNITS_SETTING, useSetting, VIEWER_SETTING } from "@/lib/settings";
import { UNIT_LABELS, UNITS, type Units } from "@/lib/units";
import type { ViewerOptions } from "@/components/studio/viewer";

type Props = {
  accountEmail: string;
  /** The studio, on the part it had open. */
  backHref: string;
  models: { default: string; models: ModelInfo[] };
  interestUrl?: string;
  /** Shows the admin section. */
  isAdmin: boolean;
};

const VIEWER_TOGGLES: [keyof ViewerOptions, string, string][] = [
  ["edges", "Edges", "B-rep edges (creases over 25°)"],
  ["wireframe", "Wireframe", "the mesh triangles"],
  ["grid", "Grid", "a ground grid sized to the part"],
  ["dims", "Dimensions", "bounding-box dimensions"],
  ["banana", "Banana", "a life-size banana beside the part, for scale"],
];

export function Settings({ accountEmail, backHref, models, interestUrl, isAdmin }: Props) {
  return (
    <div className="settings-page">
      <header>
        <strong>gooey-studio</strong>
        <Link className="button" href={backHref}>
          ← Studio
        </Link>
        <span className="spacer" />
        <span className="muted small account-email" title={accountEmail}>{accountEmail}</span>
      </header>
      <main className="settings">
        <h1>Settings</h1>
        <Account email={accountEmail} />
        <Preferences models={models} />
        <AiUsage interestUrl={interestUrl} />
        {isAdmin && (
          <section className="settings-card admin" aria-labelledby="settings-admin">
            <h2 id="settings-admin">Admin</h2>
            <p className="hint">Studio-wide settings for administrators will appear here.</p>
          </section>
        )}
      </main>
    </div>
  );
}

function Account({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signOut = async () => {
    setBusy(true);
    setError(null);
    try {
      const { error } = await authClient.signOut();
      if (error) throw new Error(error.message ?? "Could not sign out.");
      location.replace("/login");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <section className="settings-card" aria-labelledby="settings-account">
      <h2 id="settings-account">Account</h2>
      <div className="row">
        <span>Email</span>
        <span className="value">{email}</span>
      </div>
      <div className="row">
        <span />
        <div>
          <button onClick={signOut} disabled={busy}>
            {busy ? "Signing out…" : "Sign out"}
          </button>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      </div>
    </section>
  );
}

// Each control writes its setting at once; the studio reads them when it opens (and live in
// other open tabs).
function Preferences({ models }: { models: Props["models"] }) {
  const [units, setUnits] = useSetting(UNITS_SETTING);
  const [stored, setModel] = useSetting(MODEL_SETTING);
  const [viewOpts, setViewOpts] = useSetting(VIEWER_SETTING);
  // As the chat picks it: the stored model if it still exists, else the server's default.
  const model = stored && models.models.some((m) => m.id === stored) ? stored : models.default;
  const vendors = [...new Set(models.models.map((m) => m.vendor))];
  return (
    <section className="settings-card" aria-labelledby="settings-prefs">
      <h2 id="settings-prefs">Preferences</h2>
      <p className="hint">Kept in this browser.</p>
      <div className="row">
        <label htmlFor="settings-units">Units</label>
        <div>
          <select id="settings-units" value={units} onChange={(e) => setUnits(e.target.value as Units)}>
            {UNITS.map((u) => (
              <option key={u} value={u}>
                {UNIT_LABELS[u]}
              </option>
            ))}
          </select>
          <p className="hint">Every dimension the studio shows, new parts and the agent&apos;s answers. Each script keeps the units it declares.</p>
        </div>
      </div>
      <div className="row">
        <label htmlFor="settings-model">AI model</label>
        <div>
          <select id="settings-model" value={model} onChange={(e) => setModel(e.target.value)}>
            {vendors.map((v) => (
              <optgroup key={v} label={v}>
                {models.models
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
          <p className="hint">Chats start on this model. Picking a model in a chat changes it too.</p>
        </div>
      </div>
      <div className="row">
        <span>Preview</span>
        <div>
          <div className="checks">
            {VIEWER_TOGGLES.map(([k, label, title]) => (
              <label key={k} title={title}>
                <input type="checkbox" checked={viewOpts[k]} onChange={() => setViewOpts({ ...viewOpts, [k]: !viewOpts[k] })} />
                {label}
              </label>
            ))}
          </div>
          <p className="hint">What the editor&apos;s preview shows. The buttons over the preview change these too.</p>
        </div>
      </div>
    </section>
  );
}

function AiUsage({ interestUrl }: { interestUrl?: string }) {
  const [quota, setQuota] = useState<ChatQuota | null>(null);
  const [failed, setFailed] = useState(false);
  // State is only set once the request settles (never synchronously in the effect).
  const load = useCallback(
    () =>
      fetch("/api/chat/quota", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<ChatQuota>) : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((q) => {
          setQuota(q);
          setFailed(false);
        })
        .catch(() => setFailed(true)),
    [],
  );
  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [load]);

  const exhausted = !!quota && (quota.remaining === 0 || quota.sharedLimitReached);
  const resetAt = quota ? new Date(quota.resetAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  return (
    <section className="settings-card" aria-labelledby="settings-ai">
      <h2 id="settings-ai">AI usage</h2>
      <div aria-live="polite">
        {failed ? (
          <p>
            AI usage is temporarily unavailable.{" "}
            <button className="link" onClick={() => void load()}>
              Try again
            </button>
          </p>
        ) : !quota ? (
          <p className="muted">Checking AI usage…</p>
        ) : (
          <>
            <p>
              <strong>{quota.remaining}</strong> of {quota.limit} free AI turns left today.
              {quota.sharedLimitReached && " The studio-wide AI limit for today has been reached."}
            </p>
            <p className="hint">
              A turn is one message or retry to the agent. The allowance resets at 00:00 UTC ({resetAt} your time).
            </p>
            {exhausted && interestUrl && (
              <p>
                <a href={interestUrl}>
                  Email us for more AI access
                </a>
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
