import { useEffect, useRef, useState } from "react";
import type { BuildSummary, Finish, Resolved, Scene } from "./api";

/** Calls `fn` once `ms` after the last call. */
function useDebounced<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  const t = useRef<number | undefined>(undefined);
  const f = useRef(fn);
  f.current = fn;
  return (...a: A) => {
    clearTimeout(t.current);
    t.current = window.setTimeout(() => f.current(...a), ms);
  };
}

type ParamsProps = {
  build: BuildSummary | null;
  info: BuildSummary["info"] | null;
  overrides: Record<string, unknown>;
  disabled: boolean;
  onPatch: (params: Record<string, unknown>) => void;
};

export function Params({ info, overrides, disabled, onPatch }: ParamsProps) {
  const [local, setLocal] = useState<Record<string, unknown>>({});
  useEffect(() => {
    setLocal({});
  }, [overrides]);
  const commit = useDebounced((k: string, v: unknown) => onPatch({ [k]: v }), 250);
  if (!info) return <p className="muted pad">Parameters appear after the script loads.</p>;
  const names = Object.keys(info.defaultParams);
  if (!names.length) return <p className="muted pad">The script has no parameters.</p>;
  return (
    <div className="params">
      {names.map((k) => {
        const def = info.defaultParams[k];
        const range = info.paramRanges[k];
        const value = k in local ? local[k] : k in overrides ? overrides[k] : def;
        const overridden = k in overrides;
        const set = (v: unknown) => {
          setLocal({ ...local, [k]: v });
          commit(k, v);
        };
        return (
          <div key={k} className={`param ${overridden ? "overridden" : ""}`}>
            <label title={`default ${JSON.stringify(def)}${range ? `, range ${range[0]}…${range[1]}` : ""}`}>{k}</label>
            {typeof def === "boolean" ? (
              <input type="checkbox" checked={!!value} disabled={disabled} onChange={(e) => set(e.target.checked)} />
            ) : typeof def === "number" ? (
              <>
                {range && (
                  <input
                    type="range"
                    min={range[0]}
                    max={range[1]}
                    step={stepFor(range)}
                    value={Number(value)}
                    disabled={disabled}
                    onChange={(e) => set(Number(e.target.value))}
                  />
                )}
                <input
                  type="number"
                  className="num"
                  value={Number(value)}
                  step={range ? stepFor(range) : "any"}
                  disabled={disabled}
                  onChange={(e) => e.target.value !== "" && set(Number(e.target.value))}
                />
              </>
            ) : (
              <input type="text" value={String(value)} disabled={disabled} onChange={(e) => set(e.target.value)} />
            )}
            <button
              className="link reset"
              disabled={!overridden || disabled}
              title="reset to the script default"
              onClick={() => {
                setLocal({});
                onPatch({ [k]: null });
              }}
            >
              ↺
            </button>
          </div>
        );
      })}
    </div>
  );
}

function stepFor([lo, hi]: [number, number]): number {
  const span = hi - lo;
  return span >= 100 ? 1 : span >= 10 ? 0.5 : span >= 1 ? 0.1 : 0.01;
}

const VIEWS = ["iso", "front", "side", "top", "rear", "rear-iso"];

type LookProps = {
  scene: Scene;
  resolved: Resolved;
  finishes: Finish[];
  disabled: boolean;
  onPatch: (patch: unknown) => void;
};

/** Manual look controls; every change is a scene patch, like the agent's. */
export function Look({ scene, resolved, finishes, disabled, onPatch }: LookProps) {
  const patch = useDebounced(onPatch, 150);
  const mat = typeof scene.material === "object" && scene.material ? scene.material : {};
  const finish = typeof scene.material === "string" ? (scene.material.startsWith("#") ? "" : scene.material) : ((mat as any).finish ?? "");
  const color = typeof scene.material === "string" && scene.material.startsWith("#") ? scene.material : ((mat as any).color ?? "");
  const setMaterial = (m: Record<string, unknown>) => {
    const base: Record<string, unknown> = typeof scene.material === "object" && scene.material ? { ...scene.material } : {};
    if (typeof scene.material === "string") {
      if (scene.material.startsWith("#")) base.color = scene.material;
      else base.finish = scene.material;
    }
    // Merge-patch semantics: null deletes a key; a string material is replaced by the object.
    const next: Record<string, unknown> = { ...base, ...m };
    for (const k of Object.keys(next)) if (next[k] === "") next[k] = null;
    const left = Object.values(next).filter((v) => v !== null).length;
    onPatch({ material: left ? next : null });
  };
  const env = scene.environment;
  return (
    <div className="look">
      <div className="row">
        <label>finish</label>
        <select value={finish} disabled={disabled} onChange={(e) => setMaterial({ finish: e.target.value || null, color: null })}>
          <option value="">(none)</option>
          {finishes.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name} — {f.label}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <label>colour</label>
        <input
          type="color"
          value={color || linearToHex(resolved.material.color)}
          disabled={disabled}
          onChange={(e) => setMaterial({ color: e.target.value })}
        />
        {color && (
          <button className="link" onClick={() => setMaterial({ color: null })}>
            ↺
          </button>
        )}
      </div>
      {(["roughness", "metalness", "clearcoat"] as const).map((k) => (
        <div className="row" key={k}>
          <label>{k}</label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={resolved.material[k]}
            disabled={disabled}
            onChange={(e) => setMaterial({ [k]: Number(e.target.value) })}
          />
          <span className="val">{resolved.material[k].toFixed(2)}</span>
        </div>
      ))}
      <hr />
      <div className="row">
        <label>background</label>
        <input
          type="color"
          value={scene.background === "transparent" ? "#ffffff" : scene.background}
          disabled={disabled || scene.background === "transparent"}
          onChange={(e) => patch({ background: e.target.value })}
        />
        <label className="inline">
          <input
            type="checkbox"
            checked={scene.background === "transparent"}
            disabled={disabled}
            onChange={(e) => onPatch({ background: e.target.checked ? "transparent" : "#f2f2f0" })}
          />
          transparent
        </label>
      </div>
      <div className="row">
        <label>light</label>
        <input
          type="range"
          min={0}
          max={3}
          step={0.05}
          value={env.intensity ?? 1}
          disabled={disabled}
          onChange={(e) => patch({ environment: { intensity: Number(e.target.value) } })}
        />
        <span className="val">{(env.intensity ?? 1).toFixed(2)}</span>
      </div>
      <div className="row">
        <label>rig turn</label>
        <input
          type="range"
          min={-180}
          max={180}
          step={5}
          value={env.rotation_deg ?? 0}
          disabled={disabled}
          onChange={(e) => patch({ environment: { rotation_deg: Number(e.target.value) } })}
        />
        <span className="val">{env.rotation_deg ?? 0}°</span>
      </div>
      <div className="row">
        <label>exposure</label>
        <input
          type="range"
          min={0.2}
          max={3}
          step={0.05}
          value={scene.exposure}
          disabled={disabled}
          onChange={(e) => patch({ exposure: Number(e.target.value) })}
        />
        <span className="val">{scene.exposure.toFixed(2)}</span>
      </div>
      <div className="row">
        <label>view</label>
        <div className="views">
          {VIEWS.map((v) => (
            <button
              key={v}
              className={scene.camera.view === v ? "on" : ""}
              disabled={disabled}
              onClick={() => onPatch({ camera: { view: v } })}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
      {env.type === "room" && <p className="muted small">The room environment shows in final renders only; the preview uses the studio.</p>}
      {resolved.error && <p className="error small">{resolved.error}</p>}
    </div>
  );
}

function linearToHex(c: [number, number, number]): string {
  const s = (v: number) => {
    const x = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, x)) * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${s(c[0])}${s(c[1])}${s(c[2])}`;
}
