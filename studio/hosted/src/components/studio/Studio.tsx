"use client";
// The hosted studio: part picker and build status; script | params | look on the left, the
// three.js preview in the middle, the agent on the right; and the Renders page.
//
// Builds run remotely and take 1-3 s, so every request that builds gets a sequence number and
// only the newest one's result is applied. Scene patches are applied to the preview at once
// and sent one at a time (patches made meanwhile are merged into the next request), so
// concurrent read-modify-writes on the server cannot lose a change.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { patchScene as applyPatch, resolve, type Scene } from "@/lib/scene";
import { api, ApiError, errorMessage, sha256, type BuildSummary, type PartInfo, type Report } from "./api";
import { Editor } from "./Editor";
import { Look, Params } from "./Panels";
import { Renders } from "./Renders";
import { Viewer } from "./viewer";

const AUTOSAVE_MS = 800;
const EMPTY: Record<string, unknown> = {};

type Tab = "script" | "params" | "look";
type Mode = "editor" | "renders";
type Banner = { text: string; conflict?: { sha: string } } | null;

/** Composes two merge patches into one (later wins; nulls are kept, they delete). */
function compose(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
    out[k] = obj(prev) && obj(v) ? compose(prev, v) : v;
  }
  return out;
}

export function Studio() {
  const [parts, setParts] = useState<PartInfo[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("editor");
  const [scene, setScene] = useState<Scene | null>(null);
  const [build, setBuild] = useState<BuildSummary | null>(null);
  const [goodReport, setGoodReport] = useState<Report | null>(null);
  const [lastInfo, setLastInfo] = useState<BuildSummary["info"] | null>(null);
  const [building, setBuilding] = useState(false);
  const [tab, setTab] = useState<Tab>("script");
  const [agentBusy, setAgentBusy] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [renderSelect, setRenderSelect] = useState<string | null>(null);
  const [renderNonce, setRenderNonce] = useState(0);
  // Editor document: what the server has (`saved`) and what the editor shows.
  const [doc, setDoc] = useState({ key: "", text: "" });
  const saved = useRef<{ sha: string; text: string } | null>(null);
  const draft = useRef("");
  const loaded = useRef<string | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const viewerHost = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const lastView = useRef("");
  const currentRef = useRef<string | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const buildSeq = useRef(0);
  const meshSeq = useRef(0);
  const sceneQ = useRef<{ busy: boolean; pending: Record<string, unknown> | null }>({ busy: false, pending: null });

  const select = useCallback((name: string | null) => {
    currentRef.current = name;
    setCurrent(name);
  }, []);

  // --- loading -----------------------------------------------------------------
  const loadParts = useCallback(async () => {
    const ps = await api.parts();
    setParts(ps);
    if (!currentRef.current && ps.length) select(ps[0].name);
    return ps;
  }, [select]);

  const loadMesh = useCallback(async (name: string, v: number | string) => {
    const seq = ++meshSeq.current;
    const res = await fetch(api.meshUrl(name, v), { cache: "no-store" });
    if (!res.ok) return;
    const buf = await res.arrayBuffer();
    if (seq === meshSeq.current && currentRef.current === name) viewer.current?.setMesh(buf);
  }, []);

  const applyBuild = useCallback(
    (name: string, b: BuildSummary) => {
      setBuild(b);
      if (b.info) setLastInfo(b.info);
      if (b.ok) {
        setGoodReport((b.report as Report | undefined) ?? null);
        loadMesh(name, b.at);
        setParts((ps) => ps.map((p) => (p.name === name ? { ...p, mesh: true } : p)));
      }
    },
    [loadMesh],
  );

  /** Shows "building…" until the newest build request answers; drops stale answers. */
  const runBuild = useCallback(
    async (name: string, req: Promise<BuildSummary | null>) => {
      const seq = ++buildSeq.current;
      setBuilding(true);
      try {
        const b = await req;
        if (b && seq === buildSeq.current && currentRef.current === name) applyBuild(name, b);
      } finally {
        if (seq === buildSeq.current) setBuilding(false);
      }
    },
    [applyBuild],
  );

  const loadPart = useCallback(
    async (name: string, opts: { force?: boolean } = {}) => {
      const d = await api.part(name);
      if (currentRef.current !== name) return;
      if (!sceneQ.current.pending && !sceneQ.current.busy) {
        sceneRef.current = d.scene;
        setScene(d.scene);
      }
      setBuild(d.build);
      if (d.build?.info) setLastInfo(d.build.info);
      if (d.build?.ok) setGoodReport((d.build.report as Report | undefined) ?? null);
      // A reload of the same part (the agent changed it) must not drop unsaved edits.
      const same = loaded.current === name && !opts.force;
      const unsaved = same && saved.current !== null && draft.current !== saved.current.text;
      if (unsaved) {
        if (d.sha !== saved.current!.sha) setBanner({ text: "The script changed elsewhere while you have unsaved edits.", conflict: { sha: d.sha } });
      } else {
        saved.current = { sha: d.sha, text: d.script };
        draft.current = d.script;
        setDoc({ key: `${name}:${d.sha}:${Date.now()}`, text: d.script });
        if (opts.force) setBanner(null);
      }
      loaded.current = name;
      if (d.build) loadMesh(name, d.build.at); // the last good mesh, also after a failed build
      if (!d.build) runBuild(name, api.build(name)).catch((e) => setBanner({ text: errorMessage(e) }));
    },
    [loadMesh, runBuild],
  );

  // The preview: created once, kept while switching modes.
  useEffect(() => {
    viewer.current = new Viewer(viewerHost.current!);
    return () => {
      viewer.current?.dispose();
    };
  }, []);

  // The URL carries the part and the mode (read after hydration: the page is a static shell).
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const part = q.get("part");
    /* eslint-disable react-hooks/set-state-in-effect -- syncing from the URL once */
    if (part) select(part);
    if (q.get("mode") === "renders") setMode("renders");
    /* eslint-enable react-hooks/set-state-in-effect */
    loadParts().catch((e) => setBanner({ text: errorMessage(e) }));
  }, [loadParts, select]);

  useEffect(() => {
    if (!current) return;
    history.replaceState(null, "", `?part=${encodeURIComponent(current)}${mode === "renders" ? "&mode=renders" : ""}`);
  }, [current, mode]);

  useEffect(() => {
    if (!current) return;
    clearTimeout(saveTimer.current);
    sceneQ.current = { busy: false, pending: null };
    sceneRef.current = null;
    saved.current = null;
    loaded.current = null;
    lastView.current = "";
    buildSeq.current++;
    meshSeq.current++;
    viewer.current?.clear();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetches the part; state is set when it arrives
    loadPart(current).catch((e) => setBanner({ text: errorMessage(e) }));
  }, [current, loadPart]);

  // The look: resolved here (the same code as the server) and shown at once.
  const look = useMemo(() => {
    if (!scene) return { resolved: null, error: null };
    try {
      return { resolved: resolve(scene), error: null };
    } catch (e) {
      return { resolved: null, error: errorMessage(e) };
    }
  }, [scene]);
  useEffect(() => {
    if (!look.resolved || !scene) return;
    const view = JSON.stringify(scene.camera);
    viewer.current?.setLook(look.resolved, lastView.current !== view);
    lastView.current = view;
  }, [look, scene]);

  // --- saving --------------------------------------------------------------------
  const save = useCallback(async () => {
    clearTimeout(saveTimer.current);
    const name = currentRef.current;
    const prev = saved.current;
    if (!name || !prev || draft.current === prev.text) return;
    const text = draft.current;
    saved.current = { sha: await sha256(text), text }; // the base of the next save
    const req = api.putScript(name, text, prev.sha);
    runBuild(
      name,
      req.then((r) => r.build),
    ).catch(() => {});
    try {
      await req;
      setBanner((b) => (b?.conflict ? b : null));
    } catch (e) {
      if (currentRef.current !== name) return;
      if (e instanceof ApiError && e.status === 409) {
        saved.current = prev; // later saves keep failing until "keep mine" or "reload"
        setBanner({ text: "The script changed elsewhere (the agent, or another tab).", conflict: { sha: String(e.data.sha ?? "") } });
      } else {
        saved.current = prev;
        setBanner({ text: `Saving failed: ${errorMessage(e)}` });
      }
    }
  }, [runBuild]);

  const onChange = useCallback(
    (text: string) => {
      draft.current = text;
      clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(save, AUTOSAVE_MS);
    },
    [save],
  );

  /** Keep my edits: save them over the server's version. */
  const overwrite = (sha: string) => {
    if (!saved.current) return;
    saved.current = { sha, text: "\u0000" }; // differs from any draft, so save() sends it
    setBanner(null);
    save();
  };

  // --- scene patches -----------------------------------------------------------------
  const flushScene = useCallback(
    async (name: string) => {
      const q = sceneQ.current;
      if (q.busy) return;
      while (q.pending && currentRef.current === name && sceneQ.current === q) {
        const patch = q.pending;
        q.pending = null;
        q.busy = true;
        const req = api.patchScene(name, patch);
        if ("params" in patch) runBuild(name, req.then((r) => r.build)).catch(() => {});
        try {
          const r = await req;
          // The server's scene, unless more patches are on their way (they are shown already).
          if (!q.pending && currentRef.current === name && sceneQ.current === q) {
            sceneRef.current = r.scene;
            setScene(r.scene);
          }
        } catch (e) {
          setBanner({ text: `Scene: ${errorMessage(e)}` });
          q.pending = null;
          if (currentRef.current === name) loadPart(name).catch(() => {});
        } finally {
          q.busy = false;
        }
      }
    },
    [runBuild, loadPart],
  );

  const patchScene = useCallback(
    (patch: Record<string, unknown>) => {
      const name = currentRef.current;
      const cur = sceneRef.current;
      if (!name || !cur) return;
      let next: Scene;
      try {
        next = applyPatch(cur, patch);
      } catch (e) {
        setBanner({ text: errorMessage(e) });
        return;
      }
      sceneRef.current = next;
      setScene(next);
      const q = sceneQ.current;
      q.pending = q.pending ? compose(q.pending, patch) : patch;
      flushScene(name);
    },
    [flushScene],
  );

  // --- the agent ----------------------------------------------------------------------
  const onBusyChange = useCallback(
    (busy: boolean) => {
      setAgentBusy(busy);
      if (busy) save(); // the agent works on the saved script
    },
    [save],
  );
  const onPartChanged = useCallback(() => {
    const name = currentRef.current;
    if (!name) return;
    loadPart(name).catch((e) => setBanner({ text: errorMessage(e) }));
    loadParts().catch(() => {});
    setRenderNonce((n) => n + 1);
  }, [loadPart, loadParts]);

  // --- actions ---------------------------------------------------------------------------
  const createPart = async () => {
    const name = creating?.trim();
    if (!name) return;
    try {
      await api.createPart(name);
      setCreating(null);
      await loadParts();
      select(name);
      setMode("editor");
      setTab("script");
    } catch (e) {
      setBanner({ text: errorMessage(e) });
    }
  };

  const deletePart = async () => {
    if (!current || !confirm(`Delete ${current}.js, its scene, builds and conversation?`)) return;
    try {
      await api.deletePart(current);
      select(null);
      setScene(null);
      setBuild(null);
      viewer.current?.clear();
      const ps = await loadParts();
      if (!ps.length) setDoc({ key: "none", text: "" });
    } catch (e) {
      setBanner({ text: errorMessage(e) });
    }
  };

  const renderPart = async () => {
    if (!current) return;
    setRendering(true);
    try {
      await save();
      const j = await api.renderPart(current);
      setRenderSelect(j.id);
      setRenderNonce((n) => n + 1);
      setMode("renders");
    } catch (e) {
      setBanner({ text: errorMessage(e) });
    } finally {
      setRendering(false);
    }
  };

  const signOut = async () => {
    await fetch("/api/logout", { method: "POST" });
    location.href = "/login";
  };

  const err = build && !build.ok ? (build.error ?? null) : null;
  const report = build?.ok ? (build.report as Report | undefined) : goodReport;
  const info = build?.info ?? lastInfo ?? null;
  const hasMesh = parts.find((p) => p.name === current)?.mesh ?? false;

  return (
    <div className="app">
      <header>
        <strong>gooey-studio</strong>
        <select value={current ?? ""} onChange={(e) => select(e.target.value)} aria-label="part">
          {!current && <option value="">(no parts)</option>}
          {current && !parts.some((p) => p.name === current) && <option value={current}>{current}.js</option>}
          {parts.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}.js
            </option>
          ))}
        </select>
        <nav className="modes">
          <button className={mode === "editor" ? "on" : ""} onClick={() => setMode("editor")}>
            Editor
          </button>
          <button className={mode === "renders" ? "on" : ""} onClick={() => setMode("renders")}>
            Renders
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
            <button type="submit" disabled={!creating.trim()}>
              Create
            </button>
            <button type="button" className="link" onClick={() => setCreating(null)}>
              cancel
            </button>
          </form>
        )}
        <Status building={building} build={build} />
        <span className="spacer" />
        {current && (
          <button title="Path-trace a contact sheet of this part in its look (iso, front, side, top)" disabled={!hasMesh || rendering} onClick={renderPart}>
            {rendering ? "Rendering…" : "Render"}
          </button>
        )}
        {current && (
          <a className="button" href={api.stepUrl(current)} download={`${current}.step`} title="Build with STEP output and download it">
            STEP
          </a>
        )}
        {current && hasMesh && (
          <a className="button" href={api.stlDownloadUrl(current)} download={`${current}.stl`} title="The last good mesh">
            STL
          </a>
        )}
        {current && (
          <button className="link muted" onClick={deletePart} title="Delete this part">
            delete
          </button>
        )}
        <button className="link muted" onClick={signOut}>
          sign out
        </button>
      </header>
      {banner && (
        <div className="banner">
          {banner.text}
          {banner.conflict && (
            <button className="link" onClick={() => overwrite(banner.conflict!.sha)}>
              keep mine
            </button>
          )}
          <button
            className="link"
            onClick={() => {
              if (current) loadPart(current, { force: true }).catch((e) => setBanner({ text: errorMessage(e) }));
            }}
          >
            reload
          </button>
          <button className="link" onClick={() => setBanner(null)}>
            dismiss
          </button>
        </div>
      )}
      {mode === "renders" && <Renders parts={parts} select={renderSelect} onSelect={setRenderSelect} nonce={renderNonce} />}
      <main className={mode === "renders" ? "hidden" : ""}>
        <section className="left">
          <nav className="tabs">
            {(["script", "params", "look"] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
            {agentBusy && <span className="muted small">agent editing… (read-only)</span>}
          </nav>
          <div className={`pane ${tab === "script" ? "" : "hidden"}`}>
            <Editor docKey={doc.key} doc={doc.text} readOnly={agentBusy || !current} error={err} onChange={onChange} onSave={save} />
          </div>
          {tab === "params" && (
            <div className="pane scroll">
              <Params
                info={info}
                overrides={scene?.params ?? EMPTY}
                built={(report?.params as Record<string, unknown> | undefined) ?? null}
                disabled={agentBusy}
                onPatch={(p) => patchScene({ params: p })}
              />
            </div>
          )}
          {tab === "look" && scene && (
            <div className="pane scroll">
              <Look scene={scene} resolved={look.resolved} error={look.error} disabled={agentBusy} onPatch={patchScene} />
            </div>
          )}
          {err && (
            <div className="build-error" onClick={() => setTab("script")}>
              <b>{err.kind}</b>
              {err.line ? ` line ${err.line}${err.column ? `:${err.column}` : ""}` : ""}: {err.message}
            </div>
          )}
        </section>
        <section className={`center ${scene?.background === "transparent" ? "checker" : ""}`}>
          <div className="viewer" ref={viewerHost} />
          <div className="overlay">
            {report && (
              <div className={`chips ${build && !build.ok ? "stale" : ""}`} title={build && !build.ok ? "the last good build" : undefined}>
                <span>{report.size_mm.map((x) => x.toFixed(1)).join(" × ")} mm</span>
                <span>{(report.volume_mm3 / 1000).toFixed(1)} cm³</span>
                <span>
                  {report.pieces} piece{report.pieces === 1 ? "" : "s"}, genus {report.genus}
                </span>
                <span>{report.triangles.toLocaleString()} tris</span>
                {report.printability && (
                  <span className={report.printability.ok ? "ok" : "warn"} title={report.printability.fails.join("\n")}>
                    {report.printability.ok
                      ? "printable"
                      : `${report.printability.fails.length} print issue${report.printability.fails.length === 1 ? "" : "s"}`}
                  </span>
                )}
              </div>
            )}
            {building && <div className="building-overlay">building…</div>}
            <button className="reset-view" onClick={() => viewer.current?.resetView()}>
              reset view
            </button>
            {look.resolved?.material.finish && <div className="finish">{look.resolved.material.label ?? look.resolved.material.finish}</div>}
            {!current && <div className="empty muted">No parts yet: make one with New part.</div>}
          </div>
        </section>
        <section className="right">
          {current ? (
            <ChatPanel part={current} onPartChanged={onPartChanged} onBusyChange={onBusyChange} />
          ) : (
            <p className="muted pad">The agent works on the selected part.</p>
          )}
        </section>
      </main>
    </div>
  );
}

function Status({ building, build }: { building: boolean; build: BuildSummary | null }) {
  if (building) return <span className="status building">building…</span>;
  if (!build) return <span className="status">—</span>;
  if (!build.ok) return <span className="status bad">✗ {build.error?.kind}</span>;
  return <span className="status good">✓ {build.seconds.toFixed(2)} s</span>;
}
