import { useEffect, useMemo, useRef, useState } from "react";
import type { Finish } from "./api";

// Final renders: contact sheets and stills from the engine's path tracer
// (studio/server/src/renders.rs).

export type Upload = { sha256: string; name: string; bytes: number; triangles: number; created_ms: number };

type Cell = { index: number; x: number; y: number; w: number; h: number; label: string; input: string; view: any; material?: string };

export type Job = {
  id: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  created_ms: number;
  request: any;
  inputs: { file: string; upload?: string; part?: string }[];
  progress?: [number, number];
  error?: string;
  seconds?: number;
  image?: string;
  index?: { cells: Cell[]; width?: number; height?: number };
  log?: string[];
};

const VIEWS = ["iso", "front", "side", "top", "rear", "rear-iso"];

async function json<T>(res: Response): Promise<T> {
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error ?? res.statusText);
  return d as T;
}

type Props = {
  finishes: Finish[];
  parts: { name: string; build: { ok: boolean } | null }[];
  /** The latest `render`/`renders`/`uploads` event from the app's stream. */
  event: any;
  select: string | null;
  onSelect: (id: string | null) => void;
};

export function Renders({ finishes, parts, event, select, onSelect }: Props) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
  const [remote, setRemote] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const loadUploads = () => fetch("/api/uploads").then(json<Upload[]>).then(setUploads);
  const loadJobs = () => fetch("/api/renders").then(json<Job[]>).then(setJobs);
  useEffect(() => {
    loadUploads();
    loadJobs();
  }, []);
  useEffect(() => {
    if (!select) return setJob(null);
    fetch(`/api/renders/${select}`).then(json<Job>).then(setJob).catch(() => setJob(null));
  }, [select]);
  useEffect(() => {
    if (!event) return;
    if (event.type === "uploads") loadUploads();
    if (event.type === "renders") loadJobs();
    if (event.type === "render") {
      const j: Job = event.job;
      setJobs((js) => (js.some((x) => x.id === j.id) ? js.map((x) => (x.id === j.id ? j : x)) : [j, ...js]));
      if (j.id === select) {
        if (j.status === "done") fetch(`/api/renders/${j.id}`).then(json<Job>).then(setJob);
        else setJob((cur) => ({ ...j, log: event.line ? [...(cur?.log ?? []), event.line].slice(-40) : cur?.log }));
      }
    }
  }, [event]);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const form = new FormData();
    for (const f of files) form.append("file", f, f.name);
    setBusy(true);
    try {
      const saved = await fetch("/api/uploads", { method: "POST", body: form }).then(json<Upload[]>);
      setChosen((c) => new Set([...c, ...saved.map((u) => `u:${u.sha256}`)]));
      setErr(null);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const inputs = [...chosen].map((c) => (c.startsWith("u:") ? { upload: c.slice(2) } : { part: c.slice(2) }));
  const viewCount = views.size + orbit || 1;
  const tiles = inputs.length * viewCount * Math.max(1, mats.length);

  const submit = async () => {
    setBusy(true);
    try {
      const j = await fetch("/api/renders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "sheet",
          inputs,
          views: VIEWS.filter((v) => views.has(v)),
          orbit: orbit > 0 ? `${orbit}@${elev}` : undefined,
          materials: mats,
          tile,
          spp,
          background: transparent ? "transparent" : bg,
          environment: { type: "studio", intensity: light, rotation_deg: 0 },
          exposure,
          remote,
        }),
      }).then(json<Job>);
      setErr(null);
      onSelect(j.id);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const still = async (c: Cell) => {
    const j = job!;
    const inp = j.inputs.find((i) => `inputs/${i.file}` === c.input || c.input.endsWith(i.file));
    if (!inp) return;
    const r = j.request;
    const material = c.material ? (c.material.startsWith("{") ? JSON.parse(c.material) : c.material) : undefined;
    try {
      const s = await fetch("/api/renders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "still",
          input: inp.upload ? { upload: inp.upload } : { part: inp.part },
          view: c.view,
          material,
          width: 1600,
          spp: 1024,
          background: r.background,
          environment: r.environment,
          exposure: r.exposure,
          fov: r.fov,
        }),
      }).then(json<Job>);
      onSelect(s.id);
    } catch (e: any) {
      setErr(e.message);
    }
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
          {busy ? "working…" : "Drop STLs here, or click to choose"}
          <input ref={file} type="file" accept=".stl" multiple hidden onChange={(e) => upload(e.target.files)} />
        </div>
        <h4>Inputs</h4>
        <div className="pick">
          {uploads.map((u) => (
            <label key={u.sha256} title={`${u.triangles.toLocaleString()} triangles, ${(u.bytes / 1024).toFixed(0)} KB`}>
              <input type="checkbox" checked={chosen.has(`u:${u.sha256}`)} onChange={() => setChosen(toggle(chosen, `u:${u.sha256}`))} />
              {u.name}.stl
              <button
                className="link"
                title="remove upload"
                onClick={(e) => {
                  e.preventDefault();
                  fetch(`/api/uploads/${u.sha256}`, { method: "DELETE" });
                }}
              >
                ×
              </button>
            </label>
          ))}
          {parts
            .filter((p) => p.build?.ok)
            .map((p) => (
              <label key={p.name}>
                <input type="checkbox" checked={chosen.has(`p:${p.name}`)} onChange={() => setChosen(toggle(chosen, `p:${p.name}`))} />
                {p.name} <span className="muted small">(part)</span>
              </label>
            ))}
          {!uploads.length && !parts.some((p) => p.build?.ok) && <p className="muted small">No STLs yet.</p>}
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
          <input type="number" min={0} max={72} value={orbit} onChange={(e) => setOrbit(Math.max(0, Number(e.target.value)))} />
          <span className="muted small">views at</span>
          <input type="number" min={-89} max={89} value={elev} onChange={(e) => setElev(Number(e.target.value))} />
          <span className="muted small">°</span>
        </div>
        <h4>Finishes</h4>
        <div className="pick finishes">
          {finishes.map((f) => (
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
        <label className="inline" title="Render the tiles on Modal GPUs (engine/scripts/remote-render; needs uv and a Modal token)">
          <input type="checkbox" checked={remote} onChange={(e) => setRemote(e.target.checked)} /> render on Modal
        </label>
        {err && <p className="error small">{err}</p>}
        <button className="primary" disabled={!inputs.length || busy || tiles > 400} onClick={submit}>
          Render sheet ({tiles} tile{tiles === 1 ? "" : "s"})
        </button>
      </aside>
      <section className="render-main">
        <div className="jobs">
          {jobs.map((j) => (
            <button key={j.id} className={`job ${j.id === select ? "on" : ""} ${j.status}`} onClick={() => onSelect(j.id)}>
              <span className="job-kind">{j.request.kind}</span>
              <span className="job-in">{j.inputs.map((i) => i.file.replace(/\.stl$/, "")).join(", ")}</span>
              <span className="job-status">
                {j.status === "running" && j.progress ? `${j.progress[0]}/${j.progress[1]}` : j.status}
                {j.seconds != null && j.status === "done" ? ` · ${j.seconds}s` : ""}
              </span>
            </button>
          ))}
          {!jobs.length && <p className="muted pad">No renders yet.</p>}
        </div>
        <JobView job={job} onStill={still} />
      </section>
    </div>
  );
}

function JobView({ job, onStill }: { job: Job | null; onStill: (c: Cell) => void }) {
  const img = useRef<HTMLImageElement>(null);
  const [scale, setScale] = useState(1);
  const [hover, setHover] = useState<Cell | null>(null);
  const cells = job?.index?.cells ?? [];
  useEffect(() => setHover(null), [job?.id]);
  useEffect(() => {
    const f = () => img.current && setScale(img.current.clientWidth / img.current.naturalWidth);
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  const src = useMemo(() => (job?.status === "done" ? `/api/renders/${job.id}/image?t=${job.seconds}` : null), [job?.id, job?.status, job?.seconds]);
  if (!job) return <div className="job-view muted pad">Choose STLs and finishes on the left, or a render above.</div>;
  return (
    <div className="job-view">
      <div className="job-head">
        <b>{job.request.kind}</b> {job.id} · {job.status}
        {job.progress && job.status === "running" && <progress max={job.progress[1]} value={job.progress[0]} />}
        {(job.status === "queued" || job.status === "running") && (
          <button className="link" onClick={() => fetch(`/api/renders/${job.id}/cancel`, { method: "POST" })}>
            cancel
          </button>
        )}
        {src && (
          <a className="link" href={src} download={`${job.id}.png`}>
            download
          </a>
        )}
        <button className="link" onClick={() => fetch(`/api/renders/${job.id}`, { method: "DELETE" })}>
          delete
        </button>
        {hover && <span className="muted">{hover.label} — click for a 1600 px still</span>}
      </div>
      {job.error && <pre className="error small">{job.error}</pre>}
      {src && (
        <div className="sheet-wrap">
          <div className="sheet">
            <img
              ref={img}
              src={src}
              onLoad={(e) => setScale(e.currentTarget.clientWidth / e.currentTarget.naturalWidth)}
              onClick={() => img.current && setScale(img.current.clientWidth / img.current.naturalWidth)}
            />
            {cells.map((c) => (
              <div
                key={c.index}
                className="cell"
                style={{ left: c.x * scale, top: c.y * scale, width: c.w * scale, height: c.h * scale }}
                onMouseEnter={() => setHover(c)}
                onMouseLeave={() => setHover(null)}
                onClick={() => onStill(c)}
              />
            ))}
          </div>
        </div>
      )}
      {!src && job.log && job.log.length > 0 && <pre className="log">{job.log.join("\n")}</pre>}
    </div>
  );
}
