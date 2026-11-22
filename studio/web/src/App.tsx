import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtSize, fmtVolume, sha256, subscribe, type BuildSummary, type Finish, type Info, type PartData } from "./api";
import { Editor } from "./Editor";
import { Chat, applyAgentEvent, fromStored, type TurnView } from "./Chat";
import { Look, Params } from "./Panels";
import { Viewer } from "./viewer";
import { Renders } from "./Renders";

const AUTOSAVE_MS = 400;

type Tab = "script" | "params" | "look";

export function App() {
  const [info, setInfo] = useState<Info | null>(null);
  const [parts, setParts] = useState<{ name: string; build: { ok: boolean; rev: number } | null }[]>([]);
  const [mode, setMode] = useState<"editor" | "renders">(() =>
    new URLSearchParams(location.search).get("mode") === "renders" ? "renders" : "editor",
  );
  const [renderEvent, setRenderEvent] = useState<any>(null);
  const [renderJob, setRenderJob] = useState<string | null>(null);
  const [finishes, setFinishes] = useState<Finish[]>([]);
  const [current, setCurrent] = useState<string | null>(() => new URLSearchParams(location.search).get("part"));
  const [part, setPart] = useState<PartData | null>(null);
  const [build, setBuild] = useState<BuildSummary | null>(null);
  const [building, setBuilding] = useState(false);
  const [lastInfo, setLastInfo] = useState<BuildSummary["info"] | null>(null);
  const [tab, setTab] = useState<Tab>("script");
  const [turns, setTurns] = useState<TurnView[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  // Editor document: what the server has (`saved`) and what the editor shows.
  const [doc, setDoc] = useState({ key: "", text: "" });
  const saved = useRef<{ sha: string; text: string } | null>(null);
  const draft = useRef<string>("");
  const loaded = useRef<string | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const viewerHost = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const lastView = useRef<string>("");
  const currentRef = useRef(current);
  currentRef.current = current;

  // --- loading -------------------------------------------------------------
  const loadParts = useCallback(async () => {
    const ps = await api.parts();
    setParts(ps);
    if (!currentRef.current && ps.length) setCurrent(ps[0].name);
  }, []);

  const loadMesh = useCallback(async (name: string, rev: number) => {
    const res = await fetch(api.meshUrl(name, rev));
    if (res.ok && currentRef.current === name) viewer.current?.setMesh(await res.arrayBuffer());
  }, []);

  const loadPart = useCallback(
    async (name: string) => {
      const d = await api.part(name);
      if (currentRef.current !== name) return;
      setPart(d);
      setBuild(d.build);
      setBuilding(!d.build);
      if (d.build?.info) setLastInfo(d.build.info);
      // A reload of the same part (e.g. on reconnect) must not drop unsaved edits.
      const same = loaded.current === name;
      const unsaved = same && saved.current !== null && draft.current !== saved.current.text;
      if (unsaved) {
        if (d.sha !== saved.current!.sha) setBanner("The script changed on disk while you have unsaved edits. Reload to take the new version.");
      } else {
        saved.current = { sha: d.sha, text: d.script };
        draft.current = d.script;
        setDoc({ key: `${name}:${d.sha}`, text: d.script });
      }
      loaded.current = name;
      setRunning(d.turn);
      if (!d.resolved.error) {
        const view = JSON.stringify(d.scene.camera);
        viewer.current?.setLook(d.resolved, lastView.current !== view);
        lastView.current = view;
      }
      if (d.good_rev != null) loadMesh(name, d.good_rev);
      const chat = await api.chat(name);
      setTurns(chat.turns.map(fromStored));
    },
    [loadMesh],
  );

  useEffect(() => {
    api.info().then(setInfo);
    api.library().then((l) => setFinishes(l.finishes));
    loadParts();
  }, [loadParts]);

  useEffect(() => {
    viewer.current = new Viewer(viewerHost.current!);
    return () => viewer.current?.dispose();
  }, []);

  useEffect(() => {
    if (!current) return;
    history.replaceState(null, "", `?part=${encodeURIComponent(current)}${mode === "renders" ? "&mode=renders" : ""}`);
    setPart(null);
    setBuild(null);
    setLastInfo(null);
    setTurns([]);
    setBanner(null);
    lastView.current = "";
    loadPart(current).catch((e) => setBanner(String(e.message ?? e)));
  }, [current, loadPart]);

  // --- saving --------------------------------------------------------------
  const save = useCallback(async () => {
    clearTimeout(saveTimer.current);
    const name = currentRef.current;
    if (!name || !saved.current || draft.current === saved.current.text) return;
    const text = draft.current;
    try {
      const r = await api.putScript(name, text, saved.current.sha);
      saved.current = { sha: r.sha, text };
      setBanner(null);
    } catch (e: any) {
      setBanner(e.status === 409 ? `${e.message}. Reload to get the new version (your edits are kept in the editor until then).` : e.message);
    }
  }, []);

  const onChange = (text: string) => {
    draft.current = text;
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(save, AUTOSAVE_MS);
  };

  // --- live events -----------------------------------------------------------
  useEffect(
    () =>
      subscribe(async (e) => {
        const name = currentRef.current;
        if (e.type === "parts") loadParts();
        if (e.type === "render" || e.type === "renders" || e.type === "uploads") {
          setRenderEvent(e);
          return;
        }
        if (e.type === "build") setParts((ps) => ps.map((p) => (p.name === e.part ? { ...p, build: { ok: e.ok, rev: e.rev } } : p)));
        if (e.type === "resync") {
          loadParts();
          if (name) loadPart(name);
        }
        if (!name || e.part !== name) {
          if (e.type === "script" && e.part && !parts.some((p) => p.name === e.part)) loadParts();
          return;
        }
        switch (e.type) {
          case "building":
            setBuilding(true);
            break;
          case "build":
            setBuilding(false);
            setBuild(e);
            if (e.info) setLastInfo(e.info);
            if (e.ok) loadMesh(name, e.rev);
            break;
          case "script": {
            if (saved.current?.sha === e.sha) break;
            const unsaved = draft.current !== saved.current?.text;
            const d = await api.part(name);
            if (unsaved && (await sha256(draft.current)) !== d.sha) {
              setBanner("The script changed on disk while you have unsaved edits. Reload to take the new version.");
              break;
            }
            saved.current = { sha: d.sha, text: d.script };
            draft.current = d.script;
            setDoc({ key: `${name}:${d.sha}`, text: d.script });
            break;
          }
          case "scene":
            setPart((p) => (p ? { ...p, scene: e.scene, resolved: e.resolved } : p));
            if (!e.resolved.error) {
              const view = JSON.stringify(e.scene.camera);
              viewer.current?.setLook(e.resolved, lastView.current !== view);
              lastView.current = view;
            }
            break;
          case "agent":
            setTurns((t) => applyAgentEvent(t, e));
            if (e.kind === "start") setRunning(e.turn);
            if (e.kind === "done") setRunning(null);
            break;
        }
      }),
    [loadParts, loadPart, loadMesh, parts],
  );

  // --- actions ---------------------------------------------------------------
  const patchScene = (patch: unknown) => {
    if (!current) return;
    api.patchScene(current, patch).catch((e) => setBanner(e.message));
  };

  const newPart = async () => {
    const name = prompt("New part name (letters, digits, - _ .)");
    if (!name) return;
    try {
      await api.createPart(name);
      await loadParts();
      setCurrent(name);
    } catch (e: any) {
      alert(e.message);
    }
  };

  const err = build && !build.ok ? build.error ?? null : null;
  const report = build?.report;
  const agentOn = !!info?.agent;

  return (
    <div className="app">
      <header>
        <strong>gooey-studio</strong>
        <select value={current ?? ""} onChange={(e) => setCurrent(e.target.value)}>
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
        <button onClick={newPart}>New part</button>
        <Status building={building} build={build} />
        <span className="spacer" />
        {current && (
          <button
            title="Path-trace a contact sheet of this part in its look (iso, front, side, top)"
            disabled={!part?.good_rev && !build?.ok}
            onClick={async () => {
              try {
                const res = await fetch(`/api/parts/${encodeURIComponent(current)}/render`, { method: "POST" });
                const j = await res.json();
                if (!res.ok) throw new Error(j.error);
                setRenderJob(j.id);
                setMode("renders");
              } catch (e: any) {
                setBanner(e.message);
              }
            }}
          >
            Render
          </button>
        )}
        {current && (
          <a className="button" href={api.stepUrl(current)} download>
            STEP
          </a>
        )}
        {current && part?.build && (
          <a className="button" href={`/api/parts/${encodeURIComponent(current)}/mesh.stl?rev=${part.good_rev ?? 0}`} download={`${current}.stl`}>
            STL
          </a>
        )}
        <span className="muted small" title={info?.dir}>
          {info?.dir.split("/").slice(-2).join("/")}
        </span>
      </header>
      {banner && (
        <div className="banner">
          {banner}
          <button
            className="link"
            onClick={() => {
              if (!current) return;
              loaded.current = null; // take the server's version
              loadPart(current);
            }}
          >
            reload
          </button>
          <button className="link" onClick={() => setBanner(null)}>
            dismiss
          </button>
        </div>
      )}
      {mode === "renders" && (
        <Renders finishes={finishes} parts={parts} event={renderEvent} select={renderJob} onSelect={setRenderJob} />
      )}
      <main className={mode === "renders" ? "hidden" : ""}>
        <section className="left">
          <nav className="tabs">
            {(["script", "params", "look"] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
            {running && <span className="muted small">agent editing…</span>}
          </nav>
          <div className={`pane ${tab === "script" ? "" : "hidden"}`}>
            <Editor docKey={doc.key} doc={doc.text} readOnly={!!running} error={err} onChange={onChange} onSave={save} />
          </div>
          {tab === "params" && (
            <div className="pane scroll">
              <Params
                build={build}
                info={build?.info ?? lastInfo}
                overrides={part?.scene.params ?? {}}
                disabled={!!running}
                onPatch={(p) => patchScene({ params: p })}
              />
            </div>
          )}
          {tab === "look" && part && (
            <div className="pane scroll">
              <Look scene={part.scene} resolved={part.resolved} finishes={finishes} disabled={!!running} onPatch={patchScene} />
            </div>
          )}
          {err && (
            <div className="build-error" onClick={() => setTab("script")}>
              <b>{err.kind}</b>
              {err.line ? ` line ${err.line}${err.column ? `:${err.column}` : ""}` : ""}: {err.message}
            </div>
          )}
        </section>
        <section className={`center ${part?.scene.background === "transparent" ? "checker" : ""}`}>
          <div className="viewer" ref={viewerHost} />
          <div className="overlay">
            {report && (
              <div className="chips">
                <span>{fmtSize(report)}</span>
                <span>{fmtVolume(report)}</span>
                <span>
                  {report.pieces} piece{report.pieces === 1 ? "" : "s"}, genus {report.genus}
                </span>
                <span>{report.triangles.toLocaleString()} tris</span>
                <span className={report.printability.ok ? "ok" : "warn"} title={report.printability.fails.join("\n")}>
                  {report.printability.ok ? "printable" : `${report.printability.fails.length} print issue${report.printability.fails.length === 1 ? "" : "s"}`}
                </span>
              </div>
            )}
            <button className="reset-view" onClick={() => viewer.current?.resetView()}>
              reset view
            </button>
            {part?.resolved.material.finish && <div className="finish">{part.resolved.material.label ?? part.resolved.material.finish}</div>}
          </div>
        </section>
        <section className="right">
          <Chat
            turns={turns}
            running={!!running}
            enabled={agentOn}
            model={info?.agent?.model ?? null}
            onSend={async (m) => {
              if (!current) return;
              await save();
              api.send(current, m).catch((e) => setBanner(e.message));
            }}
            onStop={() => current && api.stop(current)}
            onRevert={(t) => {
              if (current && confirm("Restore the script and scene from before this turn?")) {
                api.revert(current, t).catch((e) => setBanner(e.message));
              }
            }}
            onClear={() => {
              if (current && confirm("Clear this part's conversation?")) {
                api.clearChat(current).then(() => setTurns([]));
              }
            }}
          />
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
