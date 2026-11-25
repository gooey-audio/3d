"use client";
// Params sliders and the look panel (ported from studio/web/src/Panels.tsx). Every change is
// a scene merge patch, like the agent's.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FINISHES, type Resolved, type Scene } from "@/lib/scene";
import { parseUnits, UNIT_LABELS } from "@/lib/units";
import type { BuildSummary } from "./api";

/** Calls `fn` once `ms` after the last call. */
export function useDebounced<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  const t = useRef<number | undefined>(undefined);
  const f = useRef(fn);
  const pending = useRef<A | null>(null);
  useLayoutEffect(() => {
    f.current = fn;
  });
  // Unmounting (a tab switch, or leaving for /parts or /settings) sends a pending call at once
  // instead of dropping it.
  useEffect(
    () => () => {
      clearTimeout(t.current);
      const a = pending.current;
      pending.current = null;
      if (a) f.current(...a);
    },
    [],
  );
  return (...a: A) => {
    clearTimeout(t.current);
    pending.current = a;
    t.current = window.setTimeout(() => {
      pending.current = null;
      f.current(...a);
    }, ms);
  };
}

type Info = NonNullable<BuildSummary["info"]>;

type ParamsProps = {
  info: Info | null;
  overrides: Record<string, unknown>;
  /** The values the last good build used (shown for parameters without an override). */
  built: Record<string, unknown> | null;
  disabled: boolean;
  onPatch: (params: Record<string, unknown>) => void;
};

export function Params({ info, overrides, built, disabled, onPatch }: ParamsProps) {
  // Values being dragged, until the scene catches up.
  const [local, setLocal] = useState<{ base: Record<string, unknown>; v: Record<string, unknown> }>({ base: overrides, v: {} });
  const edits = local.base === overrides ? local.v : {};
  const commit = useDebounced((k: string, v: unknown) => onPatch({ [k]: v }), 300);
  if (!info) return <p className="muted pad">Parameters appear after the script loads.</p>;
  const names = Object.keys(info.defaultParams);
  // Overrides of parameters the script no longer has fail the build: offer to drop them.
  const unknown = Object.keys(overrides).filter((k) => !(k in info.defaultParams));
  if (!names.length && !unknown.length) return <p className="muted pad">The script has no parameters (export <code>defaultParams</code>).</p>;
  const units = parseUnits(info.units);
  return (
    <div className="params">
      {units && <p className="muted small">Lengths in {UNIT_LABELS[units]} (the script&rsquo;s <code>units</code>).</p>}
      {unknown.map((k) => (
        <div key={k} className="param unknown">
          <label title="not a parameter of the script">{k}</label>
          <span className="error small">
            override {JSON.stringify(overrides[k])}, not in the script
          </span>
          <button className="link reset" disabled={disabled} title="remove this override" onClick={() => onPatch({ [k]: null })}>
            ×
          </button>
        </div>
      ))}
      {names.map((k) => {
        const def = info.defaultParams[k];
        const range = info.paramRanges?.[k];
        const value = k in edits ? edits[k] : k in overrides ? overrides[k] : (built?.[k] ?? def);
        const overridden = k in overrides;
        const set = (v: unknown) => {
          setLocal({ base: overrides, v: { ...edits, [k]: v } });
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
                setLocal({ base: overrides, v: {} });
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
  resolved: Resolved | null;
  error: string | null;
  disabled: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
};

/** Manual look controls; every change is a scene patch (applied to the preview at once). */
export function Look({ scene, resolved, error, disabled, onPatch }: LookProps) {
  const mat = typeof scene.material === "object" && scene.material ? (scene.material as Record<string, unknown>) : {};
  const finish = typeof scene.material === "string" ? (scene.material.startsWith("#") ? "" : scene.material) : String(mat.finish ?? "");
  const color = typeof scene.material === "string" && scene.material.startsWith("#") ? scene.material : String(mat.color ?? "");
  const setMaterial = (m: Record<string, unknown>) => {
    const base: Record<string, unknown> = { ...mat };
    if (typeof scene.material === "string") {
      if (scene.material.startsWith("#")) base.color = scene.material;
      else base.finish = scene.material;
    }
    const next: Record<string, unknown> = { ...base, ...m };
    for (const k of Object.keys(next)) if (next[k] === "" || next[k] === null) delete next[k];
    if (!Object.keys(next).length) return onPatch({ material: null });
    // Merge patch: on an object material, keys that went away are deleted with null; a
    // string material is replaced by the object.
    const isObj = typeof scene.material === "object" && scene.material !== null;
    const out: Record<string, unknown> = { ...next };
    if (isObj) for (const k of Object.keys(mat)) if (!(k in next)) out[k] = null;
    onPatch({ material: out });
  };
  const env = scene.environment as { intensity?: number; rotation_deg?: number; type: string };
  const m = resolved?.material;
  return (
    <div className="look">
      <div className="row">
        <label>finish</label>
        <select value={finish} disabled={disabled} onChange={(e) => setMaterial({ finish: e.target.value || null, color: null, roughness: null, metalness: null, clearcoat: null })}>
          <option value="">(none)</option>
          {FINISHES.map((f) => (
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
          value={color || (m ? linearToHex(m.color) : "#b8b8b4")}
          disabled={disabled}
          onChange={(e) => setMaterial({ color: e.target.value })}
        />
        {color && (
          <button className="link" disabled={disabled} onClick={() => setMaterial({ color: null })}>
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
            value={m?.[k] ?? 0}
            disabled={disabled}
            onChange={(e) => setMaterial({ [k]: Number(e.target.value) })}
          />
          <span className="val">{(m?.[k] ?? 0).toFixed(2)}</span>
          <button className="link" disabled={disabled || !(k in mat)} title="back to the finish's value" onClick={() => setMaterial({ [k]: null })}>
            ↺
          </button>
        </div>
      ))}
      <hr />
      <div className="row">
        <label>background</label>
        <input
          type="color"
          value={scene.background === "transparent" ? "#ffffff" : scene.background}
          disabled={disabled || scene.background === "transparent"}
          onChange={(e) => onPatch({ background: e.target.value })}
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
          onChange={(e) => onPatch({ environment: { intensity: Number(e.target.value) } })}
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
          onChange={(e) => onPatch({ environment: { rotation_deg: Number(e.target.value) } })}
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
          onChange={(e) => onPatch({ exposure: Number(e.target.value) })}
        />
        <span className="val">{scene.exposure.toFixed(2)}</span>
      </div>
      <div className="row">
        <label>view</label>
        <div className="views">
          {VIEWS.map((v) => (
            <button key={v} className={scene.camera.view === v ? "on" : ""} disabled={disabled} onClick={() => onPatch({ camera: { view: v } })}>
              {v}
            </button>
          ))}
        </div>
      </div>
      {env.type !== "studio" && <p className="muted small">The {env.type} environment shows in final renders only; the preview uses the studio.</p>}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

export function linearToHex(c: [number, number, number]): string {
  const s = (v: number) => {
    const x = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, x)) * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${s(c[0])}${s(c[1])}${s(c[2])}`;
}
