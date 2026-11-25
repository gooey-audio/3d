"use client";
// The hosted studio: part picker and build status; script | params | look on the left, the
// three.js preview in the middle, the agent on the right. Render mode keeps the preview and
// swaps the sides for render settings and the part's renders (see Renders.tsx).
//
// Builds run remotely and take 1-3 s, so every request that builds gets a sequence number and
// only the newest one's result is applied. Scene patches are applied to the preview at once
// and sent one at a time (patches made meanwhile are merged into the next request), so
// concurrent read-modify-writes on the server cannot lose a change.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { authClient } from "@/lib/auth-client";
import { patchScene as applyPatch, resolve, viewDirection, type Scene } from "@/lib/scene";
import type { Face, FaceSelection } from "@/lib/selection";
import { DEFAULT_UNITS, fmtSize, fmtStep, fmtVolume, parseUnits, reportUnits, UNIT_LABELS, UNITS, UNITS_STORAGE_KEY, type Units } from "@/lib/units";
import { api, ApiError, errorMessage, sha256, type BuildSummary, type PartInfo, type Report } from "./api";
import { Editor } from "./Editor";
import { History } from "./History";
import { explain } from "./printability";
import { PrintChip, PrintPanel } from "./PrintIssues";
import { Look, Params } from "./Panels";
import {
  cellInput,
  DEFAULT_SETTINGS,
  PREVIEW,
  previewLook,
  PreviewHud,
  RenderGallery,
  RenderPanel,
  renderRequest,
  RenderView,
  settingsFromJob,
  useRenderJobs,
  viewOf,
  type Cell,
  type RenderSettings,
  type View,
} from "./Renders";
import { Viewer, type Vec3, type ViewerOptions } from "./viewer";

const AUTOSAVE_MS = 800;
const TOAST_MS = 8000;
const EMPTY: Record<string, unknown> = {};
const VIEW_OPTIONS_KEY = "gooey-studio.viewer-options";
const NO_OPTIONS: ViewerOptions = { edges: false, wireframe: false, grid: false, dims: false, banana: false };

/** The build whose mesh (and face table) is stored: this one, or the last good one. */
const meshRev = (b: BuildSummary) => (b.ok ? b.rev : (b.lastGood?.rev ?? b.rev));
/** Face count and types: a selection survives rebuilds that keep them (dimension changes). */
const topology = (faces: Face[]) => `${faces.length}|${faces.map((f) => f.type).join(",")}`;
const v3 = (v: number[]): Vec3 => [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
/** Keys typed into a field are not shortcuts. */
const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");

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

export function Studio({ accountEmail, isAdmin = false, uploadPrefix, interestUrl }: { accountEmail: string; isAdmin?: boolean; uploadPrefix: string; interestUrl?: string }) {
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
  const [renderNonce, setRenderNonce] = useState(0);
  const [renderSettings, setRenderSettings] = useState<RenderSettings>(DEFAULT_SETTINGS);
  const [openRender, setOpenRender] = useState<string | null>(null);
  const [renderBusy, setRenderBusy] = useState(false);
  const [sel, setSel] = useState<FaceSelection[]>([]);
  const [viewOpts, setViewOpts] = useState<ViewerOptions>(NO_OPTIONS);
  const [gridStep, setGridStep] = useState(0);
  // The studio-wide units: what every dimension is shown in, and what new parts are written in.
  const [units, setUnitsState] = useState<Units>(DEFAULT_UNITS);
  const [dirty, setDirty] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
  const faceTable = useRef<{ rev: number; topology: string } | null>(null);
  const tabRef = useRef<Tab>("script");
  const modeRef = useRef<Mode>("editor");
  const agentBusyRef = useRef(false);
  const seenRev = useRef(0);
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
  const renders = useRenderJobs(mode === "renders", renderNonce);

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

  /** Loads the stored mesh and its face table (written together by a good build `rev`) and
   *  keeps the face selection if the topology did not change. */
  const loadMesh = useCallback(async (name: string, v: number | string, rev: number) => {
    const seq = ++meshSeq.current;
    const noFaces = () => [] as Face[];
    const [res, faces0] = await Promise.all([fetch(api.meshUrl(name, v), { cache: "no-store" }), api.faces(name).catch(noFaces)]);
    if (!res.ok) return;
    const buf = await res.arrayBuffer();
    const live = () => seq === meshSeq.current && currentRef.current === name && !!viewer.current;
    if (!live()) return;
    viewer.current!.setMesh(buf);
    let faces = faces0;
    let ok = viewer.current!.setFaces(faces);
    if (!ok && faces.length) {
      // A build landed between the two reads: the table is another mesh's. Read it again.
      faces = await api.faces(name).catch(noFaces);
      if (!live()) return;
      ok = viewer.current!.setFaces(faces);
    }
    if (!ok) faces = [];
    setGridStep(viewer.current!.gridStep);
    const prev = faceTable.current;
    const topo = topology(faces);
    faceTable.current = { rev, topology: topo };
    const byFace = new Map(faces.map((f) => [f.face, f]));
    setSel((cur) => {
      if (!cur.length) return cur;
      if (!prev || prev.topology !== topo || !faces.length) return [];
      return cur.map((s) => {
        const f = byFace.get(s.face);
        if (!f) return s;
        // The clicked point moves with the face (a dimension changed): by its centre's shift.
        const center = v3(f.center);
        const point = s.point.map((x, i) => x + center[i] - s.center[i]) as Vec3;
        return { ...s, center, normal: v3(f.normal), point, rev };
      });
    });
  }, []);

  /** A toast for a failed build the script tab does not show (another tab, or Renders). */
  const noteBuild = useCallback((b: BuildSummary) => {
    if (b.rev <= seenRev.current) return;
    seenRev.current = b.rev;
    if (b.ok || (tabRef.current === "script" && modeRef.current === "editor")) return;
    const e = b.error;
    const where = e?.line ? ` line ${e.line}${e.column ? `:${e.column}` : ""}` : "";
    setToast({ text: `${e?.kind ?? "error"}${where}: ${e?.message ?? "the build failed"}`, id: Date.now() });
  }, []);

  const applyBuild = useCallback(
    (name: string, b: BuildSummary) => {
      setBuild(b);
      noteBuild(b);
      if (b.info) setLastInfo(b.info);
      if (b.ok) {
        setGoodReport((b.report as Report | undefined) ?? null);
        loadMesh(name, b.at, b.rev);
        setParts((ps) => ps.map((p) => (p.name === name ? { ...p, mesh: true } : p)));
      } else if (b.lastGood?.report) {
        setGoodReport(b.lastGood.report as Report);
      }
    },
    [loadMesh, noteBuild],
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
      if (d.build) {
        // The first load of a part only records its rev; later reloads (the agent) may toast.
        if (loaded.current === name) noteBuild(d.build);
        else seenRev.current = d.build.rev;
      }
      if (d.build?.info) setLastInfo(d.build.info);
      if (d.build?.ok) setGoodReport((d.build.report as Report | undefined) ?? null);
      else if (d.build?.lastGood?.report) setGoodReport(d.build.lastGood.report as Report);
      // A reload of the same part (the agent changed it) must not drop unsaved edits.
      const same = loaded.current === name && !opts.force;
      const unsaved = same && saved.current !== null && draft.current !== saved.current.text;
      if (unsaved) {
        if (d.sha !== saved.current!.sha) setBanner({ text: "The script changed elsewhere while you have unsaved edits.", conflict: { sha: d.sha } });
      } else {
        saved.current = { sha: d.sha, text: d.script };
        draft.current = d.script;
        setDoc({ key: `${name}:${d.sha}:${Date.now()}`, text: d.script });
        setDirty(false);
        if (opts.force) setBanner(null);
      }
      loaded.current = name;
      if (d.build) loadMesh(name, d.build.at, meshRev(d.build)); // the last good mesh, also after a failed build
      if (!d.build) runBuild(name, api.build(name)).catch((e) => setBanner({ text: errorMessage(e) }));
    },
    [loadMesh, runBuild, noteBuild],
  );

  // The preview: created once, kept while switching modes. Clicks pick B-rep faces.
  useEffect(() => {
    const v = new Viewer(viewerHost.current!);
    viewer.current = v;
    v.events.onPick = (pick, additive) => {
      if (!pick) {
        if (!additive) setSel([]);
        return;
      }
      const f = pick.face;
      const s: FaceSelection = {
        face: f.face,
        type: f.type,
        center: v3(f.center),
        normal: v3(f.normal),
        point: pick.point,
        rev: faceTable.current?.rev ?? 0,
      };
      setSel((cur) => {
        if (!additive) return [s];
        return cur.some((c) => c.face === f.face) ? cur.filter((c) => c.face !== f.face) : [...cur, s];
      });
    };
    // Turning the preview in render mode makes its angle the still's.
    v.events.onOrbitStart = () => {
      if (modeRef.current !== "renders") return;
      setRenderSettings((s) => (s.kind === "still" && s.view !== PREVIEW ? { ...s, view: PREVIEW } : s));
    };
    return () => {
      v.dispose();
    };
  }, []);

  // Render mode: a clean preview (no face picking, selection or helpers).
  useEffect(() => {
    viewer.current?.setSelection(mode === "renders" ? [] : sel);
  }, [sel, mode]);
  useEffect(() => {
    viewer.current?.setPicking(mode !== "renders");
  }, [mode]);

  // Viewer toggles, kept in localStorage (read after hydration).
  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem(VIEW_OPTIONS_KEY) ?? "null");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reading localStorage once
      if (v && typeof v === "object") setViewOpts({ ...NO_OPTIONS, ...v });
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    viewer.current?.setOptions(mode === "renders" ? NO_OPTIONS : viewOpts);
  }, [viewOpts, mode]);
  // The units setting, kept in localStorage (read after hydration).
  useEffect(() => {
    const u = parseUnits(localStorage.getItem(UNITS_STORAGE_KEY));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading localStorage once
    if (u) setUnitsState(u);
  }, []);
  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    v.setUnits(units);
    setGridStep(v.gridStep);
  }, [units]);
  const setUnits = (u: Units) => {
    localStorage.setItem(UNITS_STORAGE_KEY, u);
    setUnitsState(u);
  };
  const toggleView = (k: keyof ViewerOptions) =>
    setViewOpts((o) => {
      const n = { ...o, [k]: !o[k] };
      localStorage.setItem(VIEW_OPTIONS_KEY, JSON.stringify(n));
      return n;
    });

  useEffect(() => {
    tabRef.current = tab;
    modeRef.current = mode;
    agentBusyRef.current = agentBusy;
  }, [tab, mode, agentBusy]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast((x) => (x?.id === toast.id ? null : x)), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

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
    faceTable.current = null;
    seenRev.current = 0;
    viewer.current?.clear(current);
    /* eslint-disable react-hooks/set-state-in-effect -- a new part: drop the old one's state */
    setSel([]);
    setGoodReport(null);
    setDirty(false);
    setToast(null);
    /* eslint-enable react-hooks/set-state-in-effect */
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
  // Render mode shows the render settings' finish, light and background instead.
  const renderLook = useMemo(() => (scene ? previewLook(renderSettings, scene) : null), [renderSettings, scene]);
  useEffect(() => {
    if (!look.resolved || !scene) return;
    if (mode === "renders") {
      viewer.current?.setLook(renderLook ?? look.resolved, false);
      return;
    }
    const view = JSON.stringify(scene.camera);
    viewer.current?.setLook(look.resolved, lastView.current !== view);
    lastView.current = view;
  }, [look, scene, mode, renderLook]);

  // --- saving --------------------------------------------------------------------
  const save = useCallback(async () => {
    clearTimeout(saveTimer.current);
    const name = currentRef.current;
    const prev = saved.current;
    if (!name || !prev || draft.current === prev.text) {
      if (prev && draft.current === prev.text) setDirty(false);
      return;
    }
    const text = draft.current;
    saved.current = { sha: await sha256(text), text }; // the base of the next save
    const req = api.putScript(name, text, prev.sha);
    runBuild(
      name,
      req.then((r) => r.build),
    ).catch(() => {});
    try {
      await req;
      if (currentRef.current === name) setDirty(draft.current !== saved.current?.text);
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
      setDirty(text !== saved.current?.text);
      clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(save, AUTOSAVE_MS);
    },
    [save],
  );

  /** Cmd/Ctrl-Enter: save now if there are edits (that builds), else rebuild. */
  const rebuildNow = useCallback(() => {
    const name = currentRef.current;
    if (!name || agentBusyRef.current) return;
    if (saved.current && draft.current !== saved.current.text) {
      save();
      return;
    }
    runBuild(name, api.build(name)).catch((e) => setBanner({ text: errorMessage(e) }));
  }, [save, runBuild]);

  // Shortcuts outside text fields: Cmd/Ctrl-Enter rebuilds, Escape clears the face selection.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typing(e.target)) return;
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && modeRef.current === "editor") {
        e.preventDefault();
        rebuildNow();
      } else if (e.key === "Escape") {
        if (modeRef.current === "renders") setOpenRender(null);
        else setSel((s) => (s.length ? [] : s));
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [rebuildNow]);

  /** Restores a checkpoint (saving the current script as one first, so it can be undone). */
  const restoreCheckpoint = useCallback(
    async (id: string) => {
      const name = currentRef.current;
      if (!name) return;
      if (saved.current && draft.current !== saved.current.text && !confirm("Discard your unsaved edits and restore this checkpoint?")) return;
      clearTimeout(saveTimer.current);
      await api.saveCheckpoint(name);
      const req = api.revert(name, id);
      runBuild(
        name,
        req.then((r) => r.build),
      ).catch(() => {});
      await req;
      await loadPart(name, { force: true });
    },
    [runBuild, loadPart],
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
      await api.createPart(name, units);
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
      setSel([]);
      viewer.current?.clear();
      const ps = await loadParts();
      if (!ps.length) setDoc({ key: "none", text: "" });
    } catch (e) {
      setBanner({ text: errorMessage(e) });
    }
  };

  // --- render mode -----------------------------------------------------------------------
  const frame = useCallback((v: View) => {
    if (v === PREVIEW) return;
    try {
      viewer.current?.frameView(viewDirection(v));
    } catch {
      /* not a view */
    }
  }, []);

  const queueRender = async (req: unknown) => {
    setRenderBusy(true);
    try {
      const j = await renders.start(req);
      renders.setErr(null);
      return j;
    } catch (e) {
      renders.setErr(errorMessage(e));
      return null;
    } finally {
      setRenderBusy(false);
    }
  };

  const startRender = () => {
    if (!current || !scene || !viewer.current) return;
    const v = viewer.current;
    queueRender(renderRequest(renderSettings, current, scene, () => v.cameraDirection()));
  };

  /** One tile of a sheet as an image, with the form's size and quality and the sheet's light. */
  const renderTile = async (job: (typeof renders.jobs)[number], c: Cell) => {
    const part = cellInput(job, c)?.part;
    if (!part) return false;
    const r = job.request as Record<string, unknown>;
    const asked = (r.materials as unknown[] | undefined)?.length;
    const material = asked && c.material ? (c.material.startsWith("{") ? JSON.parse(c.material) : c.material) : undefined;
    const j = await queueRender({
      kind: "still",
      input: { part },
      view: viewOf(c.view),
      material,
      width: renderSettings.width,
      aspect: renderSettings.aspect,
      spp: Math.max(renderSettings.spp, Number(r.spp ?? 0)),
      background: r.background,
      environment: r.environment,
      exposure: r.exposure,
      fov: r.fov,
    });
    return !!j;
  };

  /** Loads a render's (or a sheet tile's) settings into the form, on its part. */
  const editRender = (job: (typeof renders.jobs)[number], c?: Cell) => {
    const part = c ? cellInput(job, c)?.part : job.inputs[0]?.part;
    if (!part) return;
    const next = settingsFromJob(job, part === current ? scene : null, renderSettings, c);
    setRenderSettings(next);
    setOpenRender(null);
    if (part !== current) select(part);
    else frame(next.kind === "still" ? next.view : (next.views[0] ?? PREVIEW));
  };

  const signOut = async () => {
    try {
      const { error } = await authClient.signOut();
      if (error) throw new Error(error.message ?? "Could not sign out.");
      location.replace("/login");
    } catch (e) {
      setBanner({ text: errorMessage(e) });
    }
  };

  const err = build && !build.ok ? (build.error ?? null) : null;
  const report = build?.ok ? (build.report as Report | undefined) : (goodReport ?? (build?.lastGood?.report as Report | undefined));
  const stale = !!build && !build.ok;
  const info = build?.info ?? lastInfo ?? null;
  const hasMesh = parts.find((p) => p.name === current)?.mesh ?? false;
  const openJob = renders.jobs.find((j) => j.id === openRender) ?? null;
  const printability = report?.printability;
  const print = useMemo(() => (printability ? explain(printability.fails, printability.material, units) : null), [printability, units]);
  const printMarks = printOpen && mode !== "renders" && print && !printability?.ok ? print.marks : null;
  useEffect(() => {
    viewer.current?.setPrintMarks(printMarks);
  }, [printMarks]);

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
          <button className={mode === "renders" ? "on" : ""} onClick={() => setMode("renders")} title="Path-traced images of this part">
            Render
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
        <select
          className="units"
          value={units}
          onChange={(e) => setUnits(e.target.value as Units)}
          aria-label="units"
          title="Units for every dimension shown and for new parts. Each script keeps the units it declares (export const units)."
        >
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {UNIT_LABELS[u]}
            </option>
          ))}
        </select>
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
        <span className="muted small account-email" title={isAdmin ? `${accountEmail} (admin)` : accountEmail}>{accountEmail}</span>
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
      {toast && (
        <div className="toast" role="alert">
          <b>Build failed</b>
          <span className="msg" title={toast.text}>
            {toast.text}
          </span>
          <button
            className="link"
            onClick={() => {
              setMode("editor");
              setTab("script");
              setToast(null);
            }}
          >
            show
          </button>
          <button className="link" onClick={() => setToast(null)} aria-label="dismiss">
            ×
          </button>
        </div>
      )}
      <main className={mode === "renders" ? "render-mode" : ""}>
        {mode === "renders" && (
          <section className="left">
            <RenderPanel
              part={current}
              scene={scene}
              hasMesh={hasMesh}
              parts={parts}
              settings={renderSettings}
              uploadPrefix={uploadPrefix}
              onChange={setRenderSettings}
              onFrame={frame}
              onRender={startRender}
              busy={renderBusy}
              error={renders.err}
            />
          </section>
        )}
        <section className={`left ${mode === "renders" ? "hidden" : ""}`}>
          <nav className="tabs">
            {(["script", "params", "look"] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
                {t}
                {t === "script" && dirty && <span className="dot" title="unsaved: autosave pending (Cmd-S saves now)" />}
              </button>
            ))}
            {agentBusy && <span className="muted small">agent editing… (read-only)</span>}
            <span className="spacer" />
            {current && <History part={current} current={doc.text} disabled={agentBusy} onRestore={restoreCheckpoint} />}
          </nav>
          <div className={`pane ${tab === "script" ? "" : "hidden"}`}>
            <Editor docKey={doc.key} doc={doc.text} readOnly={agentBusy || !current} error={err} onChange={onChange} onSave={save} onBuild={rebuildNow} />
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
        <section className={`center ${(mode === "renders" ? renderLook?.background : scene?.background) === "transparent" ? "checker" : ""}`}>
          <div className="viewer" ref={viewerHost} />
          <div className={`overlay ${mode === "renders" ? "rendering" : ""}`}>
            <div className="topbar">
              {mode === "renders" && scene && <PreviewHud settings={renderSettings} scene={scene} />}
              {report && mode !== "renders" && (
                <div className="topbar-left">
                  <div className={`chips ${stale ? "stale" : ""}`} title={stale ? "the last good build (the latest one failed)" : undefined}>
                    {stale && <span className="stale-note">last good{build?.lastGood ? ` · rev ${build.lastGood.rev}` : ""}</span>}
                    <span>{fmtSize(report.size_mm, units)}</span>
                    <span>{fmtVolume(report.volume_mm3, units)}</span>
                    {reportUnits(report) !== units && (
                      <span title={`The script's lengths are in ${UNIT_LABELS[reportUnits(report)]} (export const units)`}>script in {reportUnits(report)}</span>
                    )}
                    <span>
                      {report.pieces} piece{report.pieces === 1 ? "" : "s"}, genus {report.genus}
                    </span>
                    <span>{report.triangles.toLocaleString()} tris</span>
                    {printability && print && (
                      <PrintChip ok={printability.ok} count={print.issues.length} open={printOpen} onToggle={() => setPrintOpen((o) => !o)} />
                    )}
                  </div>
                  {printOpen && printability && print && (
                    <PrintPanel ok={printability.ok} material={printability.material} issues={print.issues} onClose={() => setPrintOpen(false)} />
                  )}
                </div>
              )}
              <div className="view-tools">
                {(
                  [
                    ["edges", "edges", "B-rep edges (creases over 25°)"],
                    ["wireframe", "wire", "the mesh triangles"],
                    ["grid", viewOpts.grid && gridStep ? `grid ${fmtStep(gridStep, units)}` : "grid", "a ground grid sized to the part"],
                    ["dims", "dims", `bounding-box dimensions, ${units}`],
                    ["banana", "🍌", `a life-size banana (about ${units === "in" ? "7½ in" : "19 cm"}) beside the part, for scale`],
                  ] as [keyof ViewerOptions, string, string][]
                )
                  .filter(() => mode !== "renders")
                  .map(([k, label, title]) => (
                    <button key={k} className={viewOpts[k] ? "on" : ""} onClick={() => toggleView(k)} title={title} aria-pressed={viewOpts[k]}>
                      {label}
                    </button>
                  ))}
                {mode !== "renders" && <span className="sep" />}
                <button
                  className="reset-view"
                  onClick={() => {
                    const v = renderSettings.kind === "still" ? renderSettings.view : PREVIEW;
                    if (mode === "renders" && v !== PREVIEW) frame(v);
                    else viewer.current?.resetView();
                  }}
                >
                  reset view
                </button>
              </div>
            </div>
            {building && <div className="building-overlay">building…</div>}
            {sel.length > 0 && mode !== "renders" && (
              <div className="sel-pill" title={sel.map((s) => `face ${s.face} (${s.type.toLowerCase()})`).join("\n") + "\nshift-click adds or removes; Esc clears"}>
                {sel.length} face{sel.length === 1 ? "" : "s"} selected
                <button onClick={() => setSel([])} title="clear the selection (Esc)" aria-label="clear the selection">
                  ×
                </button>
              </div>
            )}
            {look.resolved?.material.finish && mode !== "renders" && <div className="finish">{look.resolved.material.label ?? look.resolved.material.finish}</div>}
            {!current && (
              <div className="empty muted">
                <div className="workspace-empty">
                  <strong>Your workspace</strong>
                  <p>Choose New part to open a starter model. Edit its script or ask the AI assistant to make a change.</p>
                </div>
              </div>
            )}
          </div>
          {mode === "renders" && openJob && (
            <RenderView
              key={openJob.id}
              job={openJob}
              scene={openJob.inputs[0]?.part === current ? scene : null}
              settings={renderSettings}
              onClose={() => setOpenRender(null)}
              onDelete={(j) => {
                setOpenRender(null);
                renders.remove(j.id).catch((e) => renders.setErr(errorMessage(e)));
              }}
              onEdit={editRender}
              onStill={renderTile}
            />
          )}
        </section>
        {mode === "renders" && (
          <section className="right">
            <RenderGallery part={current} scene={scene} jobs={renders.jobs} open={openRender} onOpen={setOpenRender} />
          </section>
        )}
        <section className={`right ${mode === "renders" ? "hidden" : ""}`}>
          {current ? (
            <ChatPanel
              part={current}
              interestUrl={interestUrl}
              onPartChanged={onPartChanged}
              onBusyChange={onBusyChange}
              selection={sel}
              onSelectionChange={setSel}
              units={units}
            />
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
