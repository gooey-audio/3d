"use client";
// Render mode: path-traced renders (on Modal) of the part open in the editor.
//
// The page reuses the editor's layout: render settings on the left, the three.js preview in the
// middle (showing the chosen finish, light and angle), and this part's renders on the right.
// Opening a render shows it over the preview. Jobs are polled every 2 s while any is pending.
import { useCallback, useEffect, useRef, useState } from "react";
import { uploadPresigned } from "@vercel/blob/client";
import { LIBRARY, resolve, resolveMaterial, VIEWS, type MaterialSpec, type Resolved, type Scene } from "@/lib/scene";
import { DIRECT_UPLOAD_MAX } from "@/lib/stl";
import { api, call, errorMessage, type PartInfo, type RenderJob, type Upload } from "./api";
import { linearToHex } from "./Panels";
import type { Vec3 } from "./viewer";

type Cell = { index: number; x: number; y: number; w: number; h: number; label: string; input: string; view: unknown; material?: string };
type SheetIndex = { cells?: Cell[] };

const POLL_MS = 2000;
const MAX_TILES = 400;
const DEFAULT_GREY = "#b8b8b4";
const VIEW_NAMES = Object.keys(VIEWS);
/** The preview's current camera, read when the render starts. */
export const PREVIEW = "preview";

export const ASPECTS: [string, number][] = [
  ["3:2", 1.5],
  ["1:1", 1],
  ["4:5", 0.8],
  ["16:9", 16 / 9],
];
export const WIDTHS = [1080, 1600, 2400, 3200];
export const QUALITY: [string, number][] = [
  ["draft", 64],
  ["standard", 256],
  ["high", 1024],
  ["final", 2048],
];
const TILES = [240, 320, 400, 600, 800];

/** A view: a name from VIEWS, PREVIEW, or a direction. */
export type View = string | Vec3;

/**
 * Material keys: "look" (the part's look), "none" (plain grey), a finish name, "#rrggbb", or a
 * JSON object (a custom material, as a sheet's index names it).
 */
export type RenderSettings = {
  kind: "still" | "sheet";
  // a still
  view: View;
  material: string;
  aspect: number;
  width: number;
  // a sheet
  views: string[];
  orbit: number;
  elev: number;
  materials: string[];
  tile: number;
  /** More inputs for a sheet: "p:<part>" or "u:<sha256>". */
  extra: string[];
  // both
  spp: number;
  /** Overrides of the part's look; unset follows it. */
  background?: string;
  light?: number;
  rotation?: number;
  exposure?: number;
};

export const DEFAULT_SETTINGS: RenderSettings = {
  kind: "still",
  view: PREVIEW,
  material: "look",
  aspect: 1.5,
  width: 1600,
  views: ["iso", "front", "side", "top"],
  orbit: 0,
  elev: 20,
  materials: [],
  tile: 400,
  extra: [],
  spp: 256,
};

// --- material keys ------------------------------------------------------------------------

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function specOf(key: string, scene: Scene): MaterialSpec | undefined {
  if (key === "look") return scene.material;
  if (key === "none") return undefined;
  return key.startsWith("{") ? (JSON.parse(key) as MaterialSpec) : key;
}

/** `scene`: the part the spec is for, if it is the open one ("look" then means its look). */
function keyOf(spec: MaterialSpec | undefined, scene: Scene | null): string {
  if (spec === undefined || spec === "") return "none";
  if (scene?.material !== undefined && same(spec, scene.material)) return "look";
  return typeof spec === "string" ? spec : JSON.stringify(spec);
}

/** A sheet index names materials as strings; objects as JSON. */
const cellKey = (m: string | undefined, scene: Scene | null) => {
  if (m === undefined) return "none";
  return keyOf(m.startsWith("{") ? (JSON.parse(m) as MaterialSpec) : m, scene);
};

function materialLabel(key: string, scene?: Scene): string {
  if (key === "look") {
    if (!scene) return "part look";
    const r = safe(() => resolveMaterial(scene.material));
    return `part look${r?.label ? ` (${r.label})` : ""}`;
  }
  if (key === "none") return "plain grey";
  if (key.startsWith("#")) return key;
  if (key.startsWith("{")) {
    const o = safe(() => JSON.parse(key) as Record<string, unknown>);
    const f = o?.finish ? LIBRARY.materials[String(o.finish)]?.label : undefined;
    return `${f ?? "custom"} (adjusted)`;
  }
  return LIBRARY.materials[key]?.label ?? key;
}

function swatch(key: string, scene: Scene): string {
  const r = safe(() => resolveMaterial(specOf(key, scene)));
  return r ? linearToHex(r.color) : DEFAULT_GREY;
}

function safe<T>(f: () => T): T | null {
  try {
    return f();
  } catch {
    return null;
  }
}

// --- requests -----------------------------------------------------------------------------

function lookOf(s: RenderSettings, scene: Scene) {
  const env = scene.environment as Record<string, unknown>;
  return {
    background: s.background ?? scene.background,
    environment: { ...env, intensity: s.light ?? Number(env.intensity ?? 1), rotation_deg: s.rotation ?? Number(env.rotation_deg ?? 0) },
    exposure: s.exposure ?? scene.exposure,
    fov: scene.camera.fov,
  };
}

const viewOut = (v: View, camera: () => Vec3) => (v === PREVIEW ? camera() : v);

function sheetMaterials(s: RenderSettings, scene: Scene): MaterialSpec[] {
  if (!s.materials.length) return scene.material !== undefined ? [scene.material] : [];
  return s.materials.map((k) => specOf(k, scene) ?? DEFAULT_GREY);
}

export function tileCount(s: RenderSettings): number {
  return (1 + s.extra.length) * Math.max(1, s.views.length + s.orbit) * Math.max(1, s.materials.length);
}

/** The POST /api/renders body for these settings. */
export function renderRequest(s: RenderSettings, part: string, scene: Scene, camera: () => Vec3) {
  const look = lookOf(s, scene);
  if (s.kind === "still") {
    return {
      kind: "still",
      input: { part },
      view: viewOut(s.view, camera),
      material: specOf(s.material, scene),
      width: s.width,
      aspect: s.aspect,
      spp: s.spp,
      ...look,
    };
  }
  const extra = s.extra.filter((x) => x !== `p:${part}`).map((x) => (x.startsWith("u:") ? { upload: x.slice(2) } : { part: x.slice(2) }));
  return {
    kind: "sheet",
    inputs: [{ part }, ...extra],
    views: s.views.map((v) => viewOut(v, camera)),
    orbit: s.orbit > 0 ? `${s.orbit}@${s.elev}` : null,
    materials: sheetMaterials(s, scene),
    tile: s.tile,
    spp: s.spp,
    ...look,
  };
}

/** What the preview shows for these settings: the still's finish, or the sheet's first. */
export function previewLook(s: RenderSettings, scene: Scene): Resolved | null {
  const key = s.kind === "still" ? s.material : (s.materials[0] ?? "look");
  const look = lookOf(s, scene);
  return safe(() =>
    resolve({
      ...scene,
      material: specOf(key, scene),
      background: look.background,
      exposure: look.exposure,
      environment: look.environment as Scene["environment"],
    }),
  );
}

/** A sheet cell's (or a request's) view as the API takes it: a name or [x, y, z]. */
export function viewOf(v: unknown): View | undefined {
  if (Array.isArray(v) && v.length === 3) return v.map(Number) as Vec3;
  if (typeof v === "string" && v.includes(",")) {
    const a = v.split(",").map(Number);
    if (a.length === 3 && a.every(Number.isFinite)) return a as Vec3;
  }
  return typeof v === "string" ? v : undefined;
}

/** The settings a job was made with (for "edit settings"), over the current ones. `scene`:
 *  the open part's, when the job is of it (else its look is taken as overrides). */
export function settingsFromJob(job: RenderJob, scene: Scene | null, cur: RenderSettings, cell?: Cell): RenderSettings {
  const r = job.request as Record<string, unknown>;
  const env = (r.environment ?? {}) as Record<string, unknown>;
  const sceneEnv = (scene?.environment ?? {}) as Record<string, unknown>;
  const views = ((r.views as unknown[]) ?? []).map(viewOf).filter((v): v is View => v !== undefined);
  const mats = ((r.materials as MaterialSpec[]) ?? []).map((m) => keyOf(m, scene));
  const s: RenderSettings = {
    ...cur,
    kind: job.kind,
    spp: Number(r.spp ?? cur.spp),
    background: r.background !== undefined && r.background !== scene?.background ? String(r.background) : undefined,
    light: env.intensity !== undefined && env.intensity !== (sceneEnv.intensity ?? 1) ? Number(env.intensity) : undefined,
    rotation: env.rotation_deg !== undefined && env.rotation_deg !== (sceneEnv.rotation_deg ?? 0) ? Number(env.rotation_deg) : undefined,
    exposure: r.exposure !== undefined && r.exposure !== scene?.exposure ? Number(r.exposure) : undefined,
  };
  if (job.kind === "still") {
    Object.assign(s, {
      view: views[0] ?? "iso",
      material: mats[0] ?? "none",
      width: Number(r.width ?? cur.width),
      aspect: Number(r.aspect ?? cur.aspect),
    });
  } else {
    const [n, at] = String(r.orbit ?? "").split("@");
    Object.assign(s, {
      views: views.filter((v): v is string => typeof v === "string"),
      orbit: Number(n) || 0,
      elev: at !== undefined ? Number(at) : cur.elev,
      materials: mats.length === 1 && mats[0] === "look" ? [] : mats,
      tile: Number(r.tile ?? cur.tile),
      extra: job.inputs.slice(1).map((i) => (i.upload ? `u:${i.upload}` : `p:${i.part}`)),
    });
  }
  if (cell) {
    // One tile of a sheet, as a still.
    s.kind = "still";
    s.view = viewOf(cell.view) ?? "iso";
    s.material = (r.materials as unknown[] | undefined)?.length ? cellKey(cell.material, scene) : "none";
  }
  return s;
}

/** What the preview is showing, over it. */
export function PreviewHud({ settings: s, scene }: { settings: RenderSettings; scene: Scene }) {
  const still = s.kind === "still";
  const views = s.views.length + s.orbit;
  const mats = s.materials.length;
  return (
    <div className="render-hud">
      <span className="hud-mode">render preview</span>
      <span>{still ? viewLabel(s.view) : `${views} view${views === 1 ? "" : "s"}`}</span>
      <span>{still || mats <= 1 ? materialLabel(still ? s.material : (s.materials[0] ?? "look"), scene) : `${mats} finishes (showing the first)`}</span>
      {still && <span>{ASPECTS.find(([, a]) => Math.abs(a - s.aspect) < 0.01)?.[0] ?? s.aspect.toFixed(2)}</span>}
    </div>
  );
}

// --- labels -------------------------------------------------------------------------------

const viewLabel = (v: unknown) => {
  const x = viewOf(v);
  if (x === undefined) return "?";
  if (x === PREVIEW) return "current angle";
  return typeof x === "string" ? x : "custom angle";
};

function jobTitle(j: RenderJob): string {
  const r = j.request as Record<string, unknown>;
  if (j.kind === "still") {
    const v = (r.views as unknown[] | undefined)?.[0];
    return `Still · ${viewLabel(v ?? "iso")}`;
  }
  const views = (r.views as unknown[] | undefined)?.length ?? 0;
  const orbit = r.orbit ? parseInt(String(r.orbit), 10) || 0 : 0;
  const n = views + orbit || 1;
  return `Sheet · ${n} view${n === 1 ? "" : "s"}`;
}

function jobDetail(j: RenderJob, scene: Scene | null): string {
  const r = j.request as Record<string, unknown>;
  const mats = (r.materials as MaterialSpec[] | undefined) ?? [];
  const bits: string[] = [];
  if (j.kind === "still") {
    bits.push(mats.length ? materialLabel(scene ? keyOf(mats[0], scene) : typeof mats[0] === "string" ? mats[0] : "{}", scene ?? undefined) : "plain grey");
    const w = Number(r.width ?? 1600);
    bits.push(`${w}×${Math.round(w / Number(r.aspect ?? 1.5))}`);
  } else {
    if (mats.length > 1) bits.push(`${mats.length} finishes`);
    else bits.push(mats.length ? materialLabel(scene ? keyOf(mats[0], scene) : String(mats[0]), scene ?? undefined) : "plain grey");
    if (j.inputs.length > 1) bits.push(`${j.inputs.length} models`);
  }
  if (r.spp) bits.push(`${r.spp} spp`);
  return bits.join(" · ");
}

/** Who asked for a job. Jobs from before `source` existed: the agent's look_at_part previews
 *  were 384 px, 48 spp sheets. */
function sourceOf(j: RenderJob): RenderJob["source"] {
  if (j.source) return j.source;
  const r = j.request as Record<string, unknown>;
  return j.kind === "sheet" && r.tile === 384 && r.spp === 48 ? "preview" : "studio";
}

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

// --- jobs ---------------------------------------------------------------------------------

/** The render jobs, refreshed when `nonce` changes and polled while any is pending. */
export function useRenderJobs(active: boolean, nonce: number) {
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => api.renders().then(setJobs, (e) => setErr(errorMessage(e))), []);
  useEffect(() => {
    if (active) load();
  }, [active, load, nonce]);
  const pending = jobs.some((j) => j.status === "pending");
  useEffect(() => {
    if (!pending) return;
    const t = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(t);
  }, [pending, load]);
  const start = useCallback(async (req: unknown) => {
    const j = await api.startRender(req);
    setJobs((js) => [j, ...js.filter((x) => x.id !== j.id)]);
    return j;
  }, []);
  const remove = useCallback(async (id: string) => {
    await api.deleteRender(id);
    setJobs((js) => js.filter((j) => j.id !== id));
  }, []);
  return { jobs, err, setErr, start, remove, reload: load };
}

// --- the settings panel (left) ------------------------------------------------------------

type PanelProps = {
  part: string | null;
  scene: Scene | null;
  hasMesh: boolean;
  parts: PartInfo[];
  uploadPrefix: string;
  settings: RenderSettings;
  onChange: (s: RenderSettings) => void;
  /** Point the preview along a view. */
  onFrame: (v: View) => void;
  onRender: () => void;
  busy: boolean;
  error: string | null;
};

const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);

export function RenderPanel({ part, scene, hasMesh, parts, uploadPrefix, settings: s, onChange, onFrame, onRender, busy, error }: PanelProps) {
  const set = (p: Partial<RenderSettings>) => onChange({ ...s, ...p });
  const [custom, setCustom] = useState("#3d5a80");
  if (!part) return <div className="render-panel pad muted">Make a part in the editor to render it.</div>;
  if (!scene) return <div className="render-panel pad muted">Loading {part}…</div>;
  const look = lookOf(s, scene);
  const tiles = tileCount(s);
  const still = s.kind === "still";
  const height = Math.round(s.width / s.aspect);
  const chosen = still ? [s.material] : s.materials;
  const pickMaterial = (k: string) => (still ? set({ material: k }) : set({ materials: toggle(s.materials, k) }));
  const groups = new Map<string, string[]>();
  for (const name of Object.keys(LIBRARY.materials)) {
    const g = name.split("/")[0];
    groups.set(g, [...(groups.get(g) ?? []), name]);
  }
  const customs = chosen.filter((k) => k.startsWith("#") || k.startsWith("{"));
  const mat = (k: string, title?: string) => (
    <button key={k} className={`mat ${chosen.includes(k) ? "on" : ""}`} title={title ?? materialLabel(k, scene)} onClick={() => pickMaterial(k)}>
      <span className="swatch" style={{ background: swatch(k, scene) }} />
      <span className="mat-name">{k.includes("/") ? k.split("/")[1] : materialLabel(k, scene)}</span>
    </button>
  );
  const disabled = !hasMesh || busy || (!still && (tiles > MAX_TILES || (!s.views.length && !s.orbit)));

  return (
    <div className="render-panel">
      <div className="render-scroll">
        <div className="render-title">
          Render <b>{part}</b>
        </div>
        <div className="seg" role="tablist">
          <button className={still ? "on" : ""} onClick={() => set({ kind: "still" })} title="One high-resolution image">
            Image
          </button>
          <button className={!still ? "on" : ""} onClick={() => set({ kind: "sheet" })} title="A grid of views × finishes, to compare">
            Contact sheet
          </button>
        </div>

        <h4>{still ? "Angle" : "Views"}</h4>
        <div className="chips-row">
          {still ? (
            <>
              <button
                className={s.view === PREVIEW ? "on" : ""}
                onClick={() => set({ view: PREVIEW })}
                title="Whatever the preview shows: drag it to choose"
              >
                current angle
              </button>
              {VIEW_NAMES.map((v) => (
                <button
                  key={v}
                  className={s.view === v ? "on" : ""}
                  onClick={() => {
                    set({ view: v });
                    onFrame(v);
                  }}
                >
                  {v}
                </button>
              ))}
              {Array.isArray(s.view) && <button className="on">custom angle</button>}
            </>
          ) : (
            <>
              {VIEW_NAMES.map((v) => (
                <button
                  key={v}
                  className={s.views.includes(v) ? "on" : ""}
                  onClick={() => {
                    set({ views: toggle(s.views, v) });
                    if (!s.views.includes(v)) onFrame(v);
                  }}
                >
                  {v}
                </button>
              ))}
              <button
                className={s.views.includes(PREVIEW) ? "on" : ""}
                onClick={() => set({ views: toggle(s.views, PREVIEW) })}
                title="Add the preview's current angle"
              >
                + current angle
              </button>
            </>
          )}
        </div>
        {still ? (
          <p className="hint">Drag the preview to pick an angle. Renders always frame the whole part.</p>
        ) : (
          <div className="row">
            <label>orbit</label>
            <input type="number" min={0} max={72} value={s.orbit} onChange={(e) => set({ orbit: Math.min(72, Math.max(0, Number(e.target.value))) })} />
            <span className="muted small">extra views at</span>
            <input type="number" min={-89} max={89} value={s.elev} onChange={(e) => set({ elev: Number(e.target.value) })} />
            <span className="muted small">°</span>
          </div>
        )}

        <h4>
          {still ? "Finish" : "Finishes"}
          {!still && <span className="muted small"> · pick several to compare{s.materials.length ? "" : " (none: the part look)"}</span>}
        </h4>
        <div className="mats">
          {mat("look", `The part's look from the Look tab: ${materialLabel("look", scene)}`)}
          {mat("none")}
          {customs.map((k) => mat(k))}
          <span className="mat custom" title="Add a plain colour">
            <input type="color" value={custom} onChange={(e) => setCustom(e.target.value)} />
            <button className="link" onClick={() => !chosen.includes(custom) && pickMaterial(custom)}>
              use colour
            </button>
          </span>
        </div>
        {[...groups].map(([g, names]) => (
          <div key={g} className="mat-group">
            <span className="mat-group-name">{g}</span>
            <div className="mats">
              {names.map((k) => mat(k))}
            </div>
          </div>
        ))}

        <h4>{still ? "Size" : "Tile size"}</h4>
        {still ? (
          <>
            <div className="chips-row">
              {ASPECTS.map(([label, a]) => (
                <button key={label} className={Math.abs(s.aspect - a) < 0.01 ? "on" : ""} onClick={() => set({ aspect: a })}>
                  {label}
                </button>
              ))}
            </div>
            <div className="chips-row">
              {WIDTHS.map((w) => (
                <button key={w} className={s.width === w ? "on" : ""} onClick={() => set({ width: w })}>
                  {w} px
                </button>
              ))}
            </div>
            <p className="hint">
              {s.width} × {height} px
            </p>
          </>
        ) : (
          <div className="chips-row">
            {TILES.map((t) => (
              <button key={t} className={s.tile === t ? "on" : ""} onClick={() => set({ tile: t })}>
                {t} px
              </button>
            ))}
          </div>
        )}

        <h4>Quality</h4>
        <div className="chips-row">
          {QUALITY.map(([label, spp]) => (
            <button key={label} className={s.spp === spp ? "on" : ""} onClick={() => set({ spp })} title={`${spp} samples per pixel`}>
              {label}
            </button>
          ))}
        </div>
        <p className="hint">{s.spp} samples per pixel: more is smoother and slower.</p>

        <h4>
          Light and background
          {(s.background !== undefined || s.light !== undefined || s.rotation !== undefined || s.exposure !== undefined) && (
            <button className="link" onClick={() => set({ background: undefined, light: undefined, rotation: undefined, exposure: undefined })}>
              use part look
            </button>
          )}
        </h4>
        <div className="row">
          <label>background</label>
          <input
            type="color"
            value={look.background === "transparent" ? "#ffffff" : look.background}
            disabled={look.background === "transparent"}
            onChange={(e) => set({ background: e.target.value })}
          />
          <label className="inline">
            <input
              type="checkbox"
              checked={look.background === "transparent"}
              onChange={(e) => set({ background: e.target.checked ? "transparent" : scene.background === "transparent" ? "#f2f2f0" : scene.background })}
            />
            transparent
          </label>
        </div>
        <Slider label="light" min={0} max={3} step={0.05} value={look.environment.intensity} set={(v) => set({ light: v })} />
        <Slider label="rig turn" min={-180} max={180} step={5} value={look.environment.rotation_deg} unit="°" set={(v) => set({ rotation: v })} />
        <Slider label="exposure" min={0.2} max={3} step={0.05} value={look.exposure} set={(v) => set({ exposure: v })} />

        {!still && <Compare part={part} parts={parts} uploadPrefix={uploadPrefix} extra={s.extra} onChange={(extra) => set({ extra })} />}
      </div>
      <div className="render-go">
        {error && <p className="error small">{error}</p>}
        {!hasMesh && <p className="muted small">This part has no good build yet.</p>}
        {!still && tiles > MAX_TILES && <p className="error small">{tiles} tiles: at most {MAX_TILES} per sheet.</p>}
        <button className="primary" disabled={disabled} onClick={onRender}>
          {busy ? "Starting…" : still ? `Render image · ${s.width}×${height}` : `Render sheet · ${tiles} tile${tiles === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}

function Slider({ label, min, max, step, value, unit, set }: { label: string; min: number; max: number; step: number; value: number; unit?: string; set: (v: number) => void }) {
  return (
    <div className="row">
      <label>{label}</label>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => set(Number(e.target.value))} />
      <span className="val">{unit ? `${value}${unit}` : value.toFixed(2)}</span>
    </div>
  );
}

/** Other parts and uploaded STLs to put on the same sheet. */
function Compare({ part, parts, uploadPrefix, extra, onChange }: { part: string; parts: PartInfo[]; uploadPrefix: string; extra: string[]; onChange: (x: string[]) => void }) {
  const [open, setOpen] = useState(extra.length > 0);
  const [uploads, setUploads] = useState<Upload[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const load = useCallback(() => api.uploads().then(setUploads, (e) => setErr(errorMessage(e))), []);
  useEffect(() => {
    if (open && uploads === null) load();
  }, [open, uploads, load]);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const saved: Upload[] = [];
    try {
      for (const f of Array.from(files)) {
        setBusy(`uploading ${f.name}…`);
        if (f.size <= DIRECT_UPLOAD_MAX) {
          const form = new FormData();
          form.append("file", f, f.name);
          const res = await fetch("/api/uploads", { method: "POST", body: form });
          const d = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(d.error ?? res.statusText);
          saved.push(...(d as Upload[]));
        } else {
          // Past the function body limit: straight to Blob with a presigned URL, then filed.
          const id = crypto.randomUUID().replace(/-/g, "");
          const pathname = `${uploadPrefix}${id}.stl`;
          await uploadPresigned(pathname, f, {
            access: "private",
            handleUploadUrl: "/api/uploads/presign",
            contentType: "model/stl",
            multipart: f.size > 32 * 1024 * 1024,
            onUploadProgress: ({ percentage }) => setBusy(`uploading ${f.name}… ${Math.round(percentage)}%`),
          });
          setBusy(`filing ${f.name}…`);
          saved.push(await call<Upload>("POST", "/api/uploads/register", { pathname, name: f.name }));
        }
      }
      setErr(null);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(null);
      if (file.current) file.current.value = "";
      if (saved.length) onChange([...extra, ...saved.map((u) => `u:${u.sha256}`).filter((k) => !extra.includes(k))]);
      load();
    }
  };

  const others = parts.filter((p) => p.mesh && p.name !== part);
  return (
    <details className="compare" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        Compare with other models{extra.length ? ` (${extra.length})` : ""}
      </summary>
      <div className="pick">
        {others.map((p) => (
          <label key={p.name}>
            <input type="checkbox" checked={extra.includes(`p:${p.name}`)} onChange={() => onChange(toggle(extra, `p:${p.name}`))} />
            {p.name}
          </label>
        ))}
        {uploads?.map((u) => (
          <label key={u.sha256} title={`${(u.bytes / 1024).toFixed(0)} KB`}>
            <input type="checkbox" checked={extra.includes(`u:${u.sha256}`)} onChange={() => onChange(toggle(extra, `u:${u.sha256}`))} />
            {u.name}.stl <span className="muted small">(upload)</span>
            <button
              className="link"
              title="remove upload"
              onClick={(e) => {
                e.preventDefault();
                if (!confirm(`Remove ${u.name}.stl?`)) return;
                api.deleteUpload(u.sha256).then(load, (x) => setErr(errorMessage(x)));
                onChange(extra.filter((k) => k !== `u:${u.sha256}`));
              }}
            >
              ×
            </button>
          </label>
        ))}
        {!others.length && !uploads?.length && <p className="muted small">No other models yet.</p>}
      </div>
      <button
        className="upload-btn"
        disabled={!!busy}
        onClick={() => file.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          upload(e.dataTransfer.files);
        }}
      >
        {busy ?? "Upload an STL…"}
      </button>
      <input ref={file} type="file" accept=".stl" multiple hidden onChange={(e) => upload(e.target.files)} />
      {err && <p className="error small">{err}</p>}
    </details>
  );
}

// --- the gallery (right) ------------------------------------------------------------------

type GalleryProps = {
  part: string | null;
  scene: Scene | null;
  jobs: RenderJob[];
  open: string | null;
  onOpen: (id: string | null) => void;
};

export function RenderGallery({ part, scene, jobs, open, onOpen }: GalleryProps) {
  const [all, setAll] = useState(false);
  const [previews, setPreviews] = useState(false);
  const mine = (j: RenderJob) => all || j.inputs.some((i) => i.part === part);
  const shown = jobs.filter((j) => mine(j) && (previews || sourceOf(j) !== "preview"));
  const hidden = jobs.filter((j) => mine(j) && sourceOf(j) === "preview").length;
  return (
    <div className="gallery">
      <div className="gallery-head">
        <b>{all ? "All renders" : "Renders of this part"}</b>
        <span className="spacer" />
        <button className={`small ${all ? "on" : ""}`} onClick={() => setAll(!all)} title="Show renders of every model">
          all models
        </button>
      </div>
      <div className="gallery-grid">
        {shown.map((j) => (
          <button key={j.id} className={`render-card ${j.status} ${j.id === open ? "on" : ""}`} onClick={() => onOpen(j.id === open ? null : j.id)}>
            <div className="thumb">
              {j.status === "done" ? (
                // eslint-disable-next-line @next/next/no-img-element -- a private API image
                <img src={api.imageUrl(j.id)} alt={jobTitle(j)} loading="lazy" />
              ) : j.status === "pending" ? (
                <span className="thumb-note">
                  <span className="spinner" /> rendering…
                </span>
              ) : (
                <span className="thumb-note error">failed</span>
              )}
            </div>
            <div className="card-meta">
              <span className="card-title">
                {jobTitle(j)}
                {sourceOf(j) === "agent" && <span className="tag">agent</span>}
                {sourceOf(j) === "preview" && <span className="tag">agent preview</span>}
              </span>
              <span className="muted small">{jobDetail(j, scene)}</span>
              <span className="muted small">
                {all || j.inputs.length > 1 ? `${j.inputs.map((i) => i.name).join(", ")} · ` : ""}
                {ago(j.created_ms)}
              </span>
            </div>
          </button>
        ))}
        {!shown.length && <p className="muted pad small">No renders yet. Choose an angle, finish and size on the left, then Render.</p>}
      </div>
      {hidden > 0 && (
        <label className="gallery-foot small muted">
          <input type="checkbox" checked={previews} onChange={(e) => setPreviews(e.target.checked)} /> show {hidden} agent preview
          {hidden === 1 ? "" : "s"}
        </label>
      )}
    </div>
  );
}

// --- an open render (over the preview) ----------------------------------------------------

type ViewProps = {
  job: RenderJob;
  scene: Scene | null;
  settings: RenderSettings;
  onClose: () => void;
  onDelete: (j: RenderJob) => void;
  /** Loads a job's settings (or one sheet tile's, as a still) into the form. */
  onEdit: (j: RenderJob, cell?: Cell) => void;
  /** Renders one sheet tile as a still with the form's size and quality. */
  onStill: (j: RenderJob, cell: Cell) => Promise<boolean>;
};

export function RenderView({ job, scene, settings, onClose, onDelete, onEdit, onStill }: ViewProps) {
  const img = useRef<HTMLImageElement>(null);
  const [scale, setScale] = useState(1);
  const [hover, setHover] = useState<Cell | null>(null);
  const [cell, setCell] = useState<Cell | null>(null);
  const [queued, setQueued] = useState<number[]>([]);
  useEffect(() => {
    const f = () => {
      if (img.current?.naturalWidth) setScale(img.current.clientWidth / img.current.naturalWidth);
    };
    const o = new ResizeObserver(f);
    if (img.current) o.observe(img.current);
    return () => o.disconnect();
  }, [job.status]);
  const cells = (job.index as SheetIndex | null)?.cells ?? [];
  const src = job.status === "done" ? api.imageUrl(job.id) : null;
  const r = job.request as Record<string, unknown>;
  const fromPart = job.inputs.some((i) => i.part);
  const height = Math.round(settings.width / settings.aspect);
  const stillSpp = Math.max(settings.spp, Number(r.spp ?? 0));

  return (
    <div className={`render-view ${r.background === "transparent" ? "checker" : ""}`}>
      <div className="render-view-head">
        <button onClick={onClose} title="Back to the live preview (Esc)">
          ← preview
        </button>
        <b>{jobTitle(job)}</b>
        <span className="muted small">
          {jobDetail(job, scene)}
          {job.status === "done" && job.seconds != null ? ` · ${job.seconds.toFixed(1)} s` : ""}
          {job.adapter ? ` · ${job.adapter}` : ""}
        </span>
        <span className="spacer" />
        {fromPart && (
          <button onClick={() => onEdit(job)} title="Load this render's angle, finish, size and light into the settings">
            edit settings
          </button>
        )}
        {src && (
          <a className="button" href={`${src}?download`} download={`${job.id}.png`}>
            download
          </a>
        )}
        <button
          className="link muted"
          onClick={() => {
            if (confirm("Delete this render?")) onDelete(job);
          }}
        >
          delete
        </button>
      </div>
      {job.error && <pre className="error small log">{job.error}</pre>}
      {job.status === "pending" && (
        <div className="render-wait">
          <span className="spinner" /> Path tracing on the GPU… usually under a minute.
        </div>
      )}
      {src && (
        <div className="render-image" onClick={(e) => e.target === e.currentTarget && setCell(null)}>
          <div className="sheet">
            {/* eslint-disable-next-line @next/next/no-img-element -- a private API image with clickable overlays */}
            <img ref={img} src={src} alt={jobTitle(job)} onLoad={(e) => setScale(e.currentTarget.clientWidth / e.currentTarget.naturalWidth)} />
            {job.kind === "sheet" &&
              cells.map((c) => (
                <div
                  key={c.index}
                  className={`cell ${cell?.index === c.index ? "on" : ""}`}
                  style={{ left: c.x * scale, top: c.y * scale, width: c.w * scale, height: c.h * scale }}
                  onMouseEnter={() => setHover(c)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => setCell(cell?.index === c.index ? null : c)}
                />
              ))}
          </div>
        </div>
      )}
      {job.kind === "sheet" && src && (
        <div className="render-view-foot">
          {cell ? (
            <>
              <b>{cell.label}</b>
              {inputIsPart(job, cell) ? (
                <>
                  {queued.includes(cell.index) ? (
                    <span className="ok small">queued: it is at the top of the renders list</span>
                  ) : (
                    <button
                      className="primary"
                      onClick={() => onStill(job, cell).then((ok) => ok && setQueued((q) => [...q, cell.index]))}
                      title="Uses the size and quality chosen on the left"
                    >
                      Render as image · {settings.width}×{height}, {stillSpp} spp
                    </button>
                  )}
                  <button onClick={() => onEdit(job, cell)}>use this angle and finish</button>
                </>
              ) : (
                <span className="muted small">an uploaded STL: use the settings form to render it</span>
              )}
              <button className="link muted" onClick={() => setCell(null)}>
                ×
              </button>
            </>
          ) : (
            <span className="muted small">{hover ? hover.label : "Click a tile to render it as a full image, or to use its angle and finish."}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** The input a sheet tile shows. */
export function cellInput(j: RenderJob, c: Cell) {
  const stem = c.input.split("/").pop()!.replace(/\.stl$/i, "");
  return j.inputs.find((i) => i.name === stem) ?? (j.inputs.length === 1 ? j.inputs[0] : undefined);
}

const inputIsPart = (j: RenderJob, c: Cell) => !!cellInput(j, c)?.part;

export type { Cell };
