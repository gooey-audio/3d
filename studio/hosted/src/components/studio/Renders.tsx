"use client";
// Final renders: contact sheets and stills from the path tracer (on Modal), ported from
// studio/web/src/Renders.tsx. Jobs are polled every 2 s while any is pending.
import { useCallback, useEffect, useRef, useState } from "react";
import { uploadPresigned } from "@vercel/blob/client";
import { FINISHES } from "@/lib/scene";
import { DIRECT_UPLOAD_MAX } from "@/lib/stl";
import { api, call, errorMessage, type PartInfo, type RenderJob, type Upload } from "./api";

type Cell = { index: number; x: number; y: number; w: number; h: number; label: string; input: string; view: unknown; material?: string };
type SheetIndex = { cells?: Cell[] };

const VIEWS = ["iso", "front", "side", "top", "rear", "rear-iso"];
const POLL_MS = 2000;

type Props = {
  parts: PartInfo[];
  select: string | null;
  onSelect: (id: string | null) => void;
  /** Bumped when something outside (the header's Render button, the agent) started a job. */
  nonce: number;
};

export function Renders({ parts, select, onSelect, nonce }: Props) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The form.
  const [chosen, setChosen] = useState<Set<string>>(new Set()); // "u:<sha>" | "p:<part>"
  const [views, setViews] = useState<Set<string>>(new Set(["iso"]));
  const [orbit, setOrbit] = useState(0);
  const [elev, setElev] = useState(20);
  const [mats, setMats] = useState<string[]>([]);
  const [custom, setCustom] = useState("#3d5a80");
  const [tile, setTile] = useState(400);
  const [spp, setSpp] = useState(256);
  const [bg, setBg] = useState("#f2f2f0");
  const [transparent, setTransparent] = useState(false);
  const [light, setLight] = useState(1);
  const [exposure, setExposure] = useState(1);
  const file = useRef<HTMLInputElement>(null);

  const loadUploads = useCallback(() => api.uploads().then(setUploads).catch((e) => setErr(errorMessage(e))), []);
  const loadJobs = useCallback(() => api.renders().then(setJobs).catch((e) => setErr(errorMessage(e))), []);
  useEffect(() => {
    loadUploads();
  }, [loadUploads]);
  useEffect(() => {
    loadJobs();
  }, [loadJobs, nonce]);

  // Poll while anything is pending (the list route refreshes pending jobs from Modal).
  const pending = jobs.some((j) => j.status === "pending");
  useEffect(() => {
    if (!pending) return;
    const t = window.setInterval(loadJobs, POLL_MS);
    return () => {
      window.clearInterval(t);
    };
  }, [pending, loadJobs]);

  const job = jobs.find((j) => j.id === select) ?? null;

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
          const pathname = `3d-studio/uploads/incoming/${id}.stl`;
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
      if (saved.length) setChosen((c) => new Set([...c, ...saved.map((u) => `u:${u.sha256}`)]));
      loadUploads();
    }
  };

  const inputs = [...chosen]
    .filter((c) => (c.startsWith("u:") ? uploads.some((u) => `u:${u.sha256}` === c) : parts.some((p) => `p:${p.name}` === c && p.mesh)))
    .map((c) => (c.startsWith("u:") ? { upload: c.slice(2) } : { part: c.slice(2) }));
  const viewCount = views.size + orbit || 1;
  const tiles = inputs.length * viewCount * Math.max(1, mats.length);

  const start = async (req: unknown) => {
    setBusy("starting render…");
    try {
      const j = await api.startRender(req);
      setJobs((js) => [j, ...js.filter((x) => x.id !== j.id)]);
      setErr(null);
      onSelect(j.id);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const submit = () =>
    start({
      kind: "sheet",
      inputs,
      views: VIEWS.filter((v) => views.has(v)),
      orbit: orbit > 0 ? `${orbit}@${elev}` : null,
      materials: mats,
      tile,
      spp,
      background: transparent ? "transparent" : bg,
      environment: { type: "studio", intensity: light, rotation_deg: 0 },
      exposure,
    });

  const still = (j: RenderJob, c: Cell) => {
    const stem = (s: string) => s.split("/").pop()!.replace(/\.stl$/i, "");
    const inp = j.inputs.find((i) => i.name === stem(c.input)) ?? (j.inputs.length === 1 ? j.inputs[0] : undefined);
    if (!inp || (!inp.part && !inp.upload)) return setErr("cannot tell which input this tile shows");
    const r = j.request as Record<string, unknown>;
    const asked = (r.materials as unknown[] | undefined)?.length;
    const material = asked && c.material ? (c.material.startsWith("{") ? JSON.parse(c.material) : c.material) : undefined;
    start({
      kind: "still",
      input: inp.upload ? { upload: inp.upload } : { part: inp.part },
      view: viewOf(c.view),
      material,
      width: 1600,
      spp: Math.max(Number(r.spp ?? 256), 512),
      background: r.background,
      environment: r.environment,
      exposure: r.exposure,
      fov: r.fov,
    });
  };

  const toggle = <T,>(set: Set<T>, v: T) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    return n;
  };

  return (
    <div className="renders">
      <aside className="render-form">
        <div
          className="drop"
          onClick={() => file.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            upload(e.dataTransfer.files);
          }}
        >
          {busy ?? "Drop STLs here, or click to choose"}
          <input ref={file} type="file" accept=".stl" multiple hidden onChange={(e) => upload(e.target.files)} />
        </div>
        <h4>Inputs</h4>
        <div className="pick">
          {uploads.map((u) => (
            <label key={u.sha256} title={`${(u.bytes / 1024).toFixed(0)} KB`}>
              <input type="checkbox" checked={chosen.has(`u:${u.sha256}`)} onChange={() => setChosen(toggle(chosen, `u:${u.sha256}`))} />
              {u.name}.stl
              <button
                className="link"
                title="remove upload"
                onClick={(e) => {
                  e.preventDefault();
                  if (!confirm(`Remove ${u.name}.stl?`)) return;
                  api.deleteUpload(u.sha256).then(loadUploads, (x) => setErr(errorMessage(x)));
                }}
              >
                ×
              </button>
            </label>
          ))}
          {parts
            .filter((p) => p.mesh)
            .map((p) => (
              <label key={p.name}>
                <input type="checkbox" checked={chosen.has(`p:${p.name}`)} onChange={() => setChosen(toggle(chosen, `p:${p.name}`))} />
                {p.name} <span className="muted small">(part)</span>
              </label>
            ))}
          {!uploads.length && !parts.some((p) => p.mesh) && <p className="muted small">No STLs yet.</p>}
        </div>
        <h4>Views</h4>
        <div className="chips-row">
          {VIEWS.map((v) => (
            <button key={v} className={views.has(v) ? "on" : ""} onClick={() => setViews(toggle(views, v))}>
              {v}
            </button>
          ))}
        </div>
        <div className="row">
          <label>orbit</label>
          <input type="number" min={0} max={72} value={orbit} onChange={(e) => setOrbit(Math.min(72, Math.max(0, Number(e.target.value))))} />
          <span className="muted small">views at</span>
          <input type="number" min={-89} max={89} value={elev} onChange={(e) => setElev(Number(e.target.value))} />
          <span className="muted small">°</span>
        </div>
        <h4>Finishes</h4>
        <div className="pick finishes">
          {FINISHES.map((f) => (
            <label key={f.name} title={f.label}>
              <input
                type="checkbox"
                checked={mats.includes(f.name)}
                onChange={() => setMats(mats.includes(f.name) ? mats.filter((m) => m !== f.name) : [...mats, f.name])}
              />
              {f.name}
            </label>
          ))}
          {mats
            .filter((m) => m.startsWith("#"))
            .map((m) => (
              <label key={m}>
                <input type="checkbox" checked onChange={() => setMats(mats.filter((x) => x !== m))} />
                <span className="swatch" style={{ background: m }} /> {m}
              </label>
            ))}
        </div>
        <div className="row">
          <input type="color" value={custom} onChange={(e) => setCustom(e.target.value)} />
          <button onClick={() => !mats.includes(custom) && setMats([...mats, custom])}>add colour</button>
          {!mats.length && <span className="muted small">none: plain grey</span>}
        </div>
        <h4>Quality and light</h4>
        <div className="row">
          <label>tile</label>
          <select value={tile} onChange={(e) => setTile(Number(e.target.value))}>
            {[240, 320, 400, 600, 800].map((t) => (
              <option key={t} value={t}>
                {t} px
              </option>
            ))}
          </select>
          <label>spp</label>
          <select value={spp} onChange={(e) => setSpp(Number(e.target.value))}>
            {[64, 128, 256, 512, 1024, 2048].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <label>background</label>
          <input type="color" value={bg} disabled={transparent} onChange={(e) => setBg(e.target.value)} />
          <label className="inline">
            <input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} /> transparent
          </label>
        </div>
        <div className="row">
          <label>light</label>
          <input type="range" min={0} max={3} step={0.05} value={light} onChange={(e) => setLight(Number(e.target.value))} />
          <span className="val">{light.toFixed(2)}</span>
        </div>
        <div className="row">
          <label>exposure</label>
          <input type="range" min={0.2} max={3} step={0.05} value={exposure} onChange={(e) => setExposure(Number(e.target.value))} />
          <span className="val">{exposure.toFixed(2)}</span>
        </div>
        {err && <p className="error small">{err}</p>}
        <button className="primary" disabled={!inputs.length || !!busy || tiles > 400} onClick={submit}>
          Render sheet ({tiles} tile{tiles === 1 ? "" : "s"})
        </button>
      </aside>
      <section className="render-main">
        <div className="jobs">
          {jobs.map((j) => (
            <button key={j.id} className={`job ${j.id === select ? "on" : ""} ${j.status}`} onClick={() => onSelect(j.id)}>
              <span className="job-kind">{j.kind}</span>
              <span className="job-in">{j.inputs.map((i) => i.name).join(", ")}</span>
              <span className="job-status">
                {j.status === "pending" ? "rendering…" : j.status}
                {j.seconds != null && j.status === "done" ? ` · ${j.seconds.toFixed(1)}s` : ""}
              </span>
            </button>
          ))}
          {!jobs.length && <p className="muted pad">No renders yet.</p>}
        </div>
        <JobView
          key={job?.id ?? "none"}
          job={job}
          onStill={still}
          onDelete={(j) => {
            api.deleteRender(j.id).then(() => {
              onSelect(null);
              loadJobs();
            }, (e) => setErr(errorMessage(e)));
          }}
        />
      </section>
    </div>
  );
}

/** A sheet cell's view as the API takes it (a name or [x, y, z]). */
function viewOf(v: unknown): string | [number, number, number] | undefined {
  if (Array.isArray(v) && v.length === 3) return v.map(Number) as [number, number, number];
  if (typeof v === "string" && v.includes(",")) {
    const a = v.split(",").map(Number);
    if (a.length === 3 && a.every(Number.isFinite)) return a as [number, number, number];
  }
  return typeof v === "string" ? v : undefined;
}

function JobView({ job, onStill, onDelete }: { job: RenderJob | null; onStill: (j: RenderJob, c: Cell) => void; onDelete: (j: RenderJob) => void }) {
  const img = useRef<HTMLImageElement>(null);
  const [scale, setScale] = useState(1);
  const [hover, setHover] = useState<Cell | null>(null);
  useEffect(() => {
    const f = () => {
      if (img.current?.naturalWidth) setScale(img.current.clientWidth / img.current.naturalWidth);
    };
    window.addEventListener("resize", f);
    return () => {
      window.removeEventListener("resize", f);
    };
  }, []);
  if (!job) return <div className="job-view muted pad">Choose STLs and finishes on the left, or a render above.</div>;
  const cells = (job.index as SheetIndex | null)?.cells ?? [];
  const src = job.status === "done" ? api.imageUrl(job.id) : null;
  const r = job.request as Record<string, unknown>;
  return (
    <div className="job-view">
      <div className="job-head">
        <b>{job.kind}</b> {job.id} · {job.status === "pending" ? "rendering…" : job.status}
        {job.adapter && <span className="muted small">{job.adapter}</span>}
        {src && (
          <a className="link" href={`${src}?download`} download={`${job.id}.png`}>
            download
          </a>
        )}
        <button className="link" onClick={() => onDelete(job)}>
          delete
        </button>
        {hover ? (
          <span className="muted">{hover.label} — click for a 1600 px still</span>
        ) : (
          <span className="muted small">
            {job.inputs.map((i) => i.name).join(", ")}
            {r.spp ? ` · ${r.spp} spp` : ""}
          </span>
        )}
      </div>
      {job.error && <pre className="error small log">{job.error}</pre>}
      {job.status === "pending" && <div className="pad muted">Path tracing on the GPU… this page checks every 2 s.</div>}
      {src && (
        <div className="sheet-wrap">
          <div className="sheet">
            {/* eslint-disable-next-line @next/next/no-img-element -- a private API image with clickable overlays */}
            <img ref={img} src={src} alt={`render ${job.id}`} onLoad={(e) => setScale(e.currentTarget.clientWidth / e.currentTarget.naturalWidth)} />
            {job.kind === "sheet" &&
              cells.map((c) => (
                <div
                  key={c.index}
                  className="cell"
                  title={c.label}
                  style={{ left: c.x * scale, top: c.y * scale, width: c.w * scale, height: c.h * scale }}
                  onMouseEnter={() => setHover(c)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => onStill(job, c)}
                />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
