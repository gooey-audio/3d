// Per-browser studio settings, kept in localStorage. Every key lives here so the studio, the
// chat and the settings page read and write the same values; add new ones as another `Setting`.
//
// `useSetting` reads through useSyncExternalStore: the server and the hydrating client render
// the fallback, then the stored value, so there is no hydration mismatch. Writes reach every
// `useSetting` in this tab at once, and other tabs through the `storage` event.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { ViewerOptions } from "@/components/studio/viewer";
import { DEFAULT_UNITS, parseUnits, type Units } from "@/lib/units";

export type Setting<T> = {
  key: string;
  fallback: T;
  /** The stored string as a value; null (or a throw) means the fallback. */
  parse: (raw: string) => T | null;
  /** The value to store; null removes the key. */
  serialize: (v: T) => string | null;
};

/** The units every dimension is shown in and new parts are written in. */
export const UNITS_SETTING: Setting<Units> = { key: "studio.units", fallback: DEFAULT_UNITS, parse: parseUnits, serialize: String };

/** The agent model a chat starts on; the chat's picker updates it too. Null: the server's default.
 *  Readers check it against the model list (the key may name a removed model). */
export const MODEL_SETTING: Setting<string | null> = {
  key: "gooey-studio.agent-model",
  fallback: null,
  parse: (s) => s || null,
  serialize: (v) => v,
};

export const NO_VIEWER_OPTIONS: ViewerOptions = { edges: false, wireframe: false, grid: false, dims: false, banana: false };

/** The preview's toggles (edges, wireframe, grid, dims, banana). */
export const VIEWER_SETTING: Setting<ViewerOptions> = {
  key: "gooey-studio.viewer-options",
  fallback: NO_VIEWER_OPTIONS,
  parse: (s) => {
    const v: unknown = JSON.parse(s);
    if (!v || typeof v !== "object") return null;
    // Only known boolean keys: a stale or hand-edited value cannot add junk options.
    const o = v as Record<string, unknown>;
    const out = { ...NO_VIEWER_OPTIONS };
    for (const k of Object.keys(out) as (keyof ViewerOptions)[]) if (typeof o[k] === "boolean") out[k] = o[k];
    return out;
  },
  serialize: (v) => JSON.stringify(v),
};

/** Whether the studio shows its script | params | look sidebar. */
export const SIDEBAR_SETTING: Setting<boolean> = {
  key: "gooey-studio.script-sidebar",
  fallback: true,
  parse: (s) => (s === "hidden" ? false : s === "shown" ? true : null),
  serialize: (v) => (v ? "shown" : "hidden"),
};

const listeners = new Set<() => void>();
// Values that could not be stored: kept for this page's life, so the setting still works.
const unsaved = new Map<string, string | null>();

// localStorage can be missing (server) or throw (storage disabled, Safari private windows).
function readRaw(key: string): string | null {
  if (typeof window === "undefined") return null;
  if (unsaved.has(key)) return unsaved.get(key)!;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function decode<T>(s: Setting<T>, raw: string | null): T {
  if (raw === null) return s.fallback;
  try {
    return s.parse(raw) ?? s.fallback;
  } catch {
    return s.fallback;
  }
}

export function readSetting<T>(s: Setting<T>): T {
  return decode(s, readRaw(s.key));
}

export function writeSetting<T>(s: Setting<T>, v: T): void {
  if (typeof window === "undefined") return;
  const raw = s.serialize(v);
  try {
    if (raw === null) window.localStorage.removeItem(s.key);
    else window.localStorage.setItem(s.key, raw);
    unsaved.delete(s.key);
  } catch {
    unsaved.set(s.key, raw);
  }
  for (const l of listeners) l();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** A setting's value (the fallback until hydrated) and its setter. */
export function useSetting<T>(s: Setting<T>): [T, (v: T) => void] {
  const raw = useSyncExternalStore(subscribe, () => readRaw(s.key), () => null);
  const value = useMemo(() => decode(s, raw), [s, raw]);
  const set = useCallback((v: T) => writeSetting(s, v), [s]);
  return [value, set];
}
