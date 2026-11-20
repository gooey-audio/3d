// The scene document (`gooey-studio-scene/v1`): parameter overrides and the look of a part,
// with `gooey-3d render` semantics. A TypeScript port of studio/server/src/scene.rs and of the
// engine's material resolution (engine/crates/render/src/{adhoc,materials,scene}.rs), so the
// three.js preview and the path-traced renders agree.

import library from "./materials.json";

export const SCHEMA = "gooey-studio-scene/v1";
export const DEFAULT_BACKGROUND = "#f2f2f0";
const DEFAULT_COLOR = "#b8b8b4";
const DEFAULT_ROUGHNESS = 0.55;

export type MaterialSpec = string | Record<string, unknown>;

export type Environment =
  | { type: "studio"; intensity?: number; rotation_deg?: number }
  | { type: "hdri"; path: string; sha256?: string; intensity?: number; rotation_deg?: number }
  | { type: "room"; [k: string]: unknown };

export type Scene = {
  schema: string;
  params?: Record<string, number | boolean | string>;
  material?: MaterialSpec;
  environment: Environment;
  background: string;
  exposure: number;
  camera: { view: string | [number, number, number]; fov: number };
};

/** Linear-RGB PBR values for three.js (`MeshPhysicalMaterial`). */
export type ResolvedMaterial = {
  finish?: string;
  label?: string;
  color: [number, number, number];
  roughness: number;
  metalness: number;
  clearcoat: number;
  clearcoat_roughness: number;
  transmission: number;
  ior: number;
  opacity: number;
  sheen: number;
};

export type Resolved = {
  material: ResolvedMaterial;
  environment: { type: string; intensity: number; rotation_deg: number; path: string | null };
  background: string;
  exposure: number;
  camera: { direction: [number, number, number]; fov: number };
};

type Entry = {
  label: string;
  color: string;
  roughness?: number;
  metalness?: number;
  opacity?: number;
  grain?: unknown;
  render?: Record<string, unknown>;
};

export const LIBRARY = library as { schema: string; materials: Record<string, Entry> };
export const FINISHES = Object.entries(LIBRARY.materials).map(([name, e]) => ({ name, label: e.label }));

// engine/crates/render/src/manifest.rs VIEWS
export const VIEWS: Record<string, [number, number, number]> = {
  iso: [1.25, 0.8, 1.5],
  front: [0, 0, 1],
  side: [1, 0, 0],
  top: [0, 1, 0.001],
  rear: [0, 0, -1],
  "rear-iso": [-1.25, 0.8, -1.5],
};

export class SceneError extends Error {}

export function defaultScene(): Scene {
  return {
    schema: SCHEMA,
    environment: { type: "studio", intensity: 1, rotation_deg: 0 },
    background: DEFAULT_BACKGROUND,
    exposure: 1,
    camera: { view: "iso", fov: 25 },
  };
}

/** Fills defaults in a stored or patched scene. */
export function normalize(v: unknown): Scene {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new SceneError("a scene must be an object");
  const o = v as Record<string, unknown>;
  const known = new Set(["schema", "params", "material", "environment", "background", "exposure", "camera"]);
  for (const k of Object.keys(o)) if (!known.has(k)) throw new SceneError(`unknown scene field \`${k}\``);
  const d = defaultScene();
  const cam = (o.camera ?? {}) as Record<string, unknown>;
  const s: Scene = {
    schema: (o.schema as string) ?? SCHEMA,
    environment: (o.environment as Environment) ?? d.environment,
    background: (o.background as string) ?? d.background,
    exposure: (o.exposure as number) ?? 1,
    camera: { view: (cam.view as Scene["camera"]["view"]) ?? "iso", fov: (cam.fov as number) ?? 25 },
  };
  if (o.params && Object.keys(o.params as object).length) s.params = o.params as Scene["params"];
  if (o.material !== undefined && o.material !== null) s.material = o.material as MaterialSpec;
  if (s.schema !== SCHEMA) throw new SceneError(`schema \`${s.schema}\` (want ${SCHEMA})`);
  return s;
}

/** JSON merge patch (RFC 7386): `null` deletes a key. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> =
    target && typeof target === "object" && !Array.isArray(target) ? { ...(target as object) } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

export function patchScene(scene: Scene, patch: unknown): Scene {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new SceneError("a scene patch must be a JSON object");
  const next = normalize(mergePatch(scene, patch));
  validate(next);
  return next;
}

export function parseHex(c: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(c);
  if (!m) throw new SceneError(`bad colour \`${c}\` (want #rrggbb)`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255) as [number, number, number];
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

export function viewDirection(v: unknown): [number, number, number] {
  if (typeof v === "string") {
    const d = VIEWS[v];
    if (!d) throw new SceneError(`camera.view \`${v}\`: want one of ${Object.keys(VIEWS).join(", ")} or [x, y, z]`);
    return d;
  }
  if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x)) && v.some((x) => x !== 0)) {
    return v as [number, number, number];
  }
  throw new SceneError("camera.view: want a view name or [x, y, z] (not all zero)");
}

const LOOK_KEYS = ["color", "roughness", "metalness", "clearcoat", "clearcoat_roughness", "transmission", "ior", "opacity", "sheen", "texture", "figure"];

/** A `--material` spec resolved like `gooey-3d render` does. */
export function resolveMaterial(spec: MaterialSpec | undefined | null): ResolvedMaterial {
  const base: { finish?: string; color: string; roughness?: number; metalness?: number; opacity?: number } = { color: DEFAULT_COLOR };
  let look: Record<string, unknown> = {};
  const entry = (name: string) => {
    const e = LIBRARY.materials[name];
    if (!e) throw new SceneError(`material: unknown finish \`${name}\``);
    return e;
  };
  if (spec === undefined || spec === null || spec === "") {
    look = { roughness: DEFAULT_ROUGHNESS };
  } else if (typeof spec === "string" && spec.startsWith("#")) {
    parseHex(spec);
    base.color = spec;
    look = { roughness: DEFAULT_ROUGHNESS };
  } else if (typeof spec === "string") {
    const e = entry(spec);
    Object.assign(base, { finish: spec, color: e.color });
  } else if (typeof spec === "object" && !Array.isArray(spec)) {
    for (const [k, v] of Object.entries(spec)) {
      if (k === "finish") base.finish = String(v);
      else if (k === "color") base.color = String(v);
      else if (k === "grain") continue;
      else if (LOOK_KEYS.includes(k)) look[k] = v;
      else throw new SceneError(`material: unknown key \`${k}\``);
    }
    if (base.finish && !("color" in spec)) base.color = entry(base.finish).color;
  } else {
    throw new SceneError("material: want a finish name, #rrggbb or an object");
  }
  let o = look;
  let label: string | undefined;
  if (base.finish) {
    const e = entry(base.finish);
    label = e.label;
    Object.assign(base, { roughness: e.roughness, metalness: e.metalness, opacity: e.opacity });
    o = { ...(e.render ?? {}), ...look };
  }
  const unit = (name: string, v: unknown) => {
    const x = Number(v);
    if (!(x >= 0 && x <= 1)) throw new SceneError(`material: ${name} ${v} outside 0..1`);
    return x;
  };
  const ior = Number(o.ior ?? 1.5);
  if (!(ior >= 1 && ior <= 3)) throw new SceneError(`material: ior ${ior} outside 1..3`);
  const color = parseHex(String(o.color ?? base.color)).map(toLinear) as [number, number, number];
  return {
    finish: base.finish,
    label,
    color,
    roughness: unit("roughness", o.roughness ?? base.roughness ?? 0.75),
    metalness: unit("metalness", o.metalness ?? base.metalness ?? 0),
    clearcoat: unit("clearcoat", o.clearcoat ?? 0),
    clearcoat_roughness: unit("clearcoat_roughness", o.clearcoat_roughness ?? 0.1),
    transmission: unit("transmission", o.transmission ?? 0),
    ior,
    opacity: unit("opacity", o.opacity ?? base.opacity ?? 1),
    sheen: unit("sheen", o.sheen ?? 0),
  };
}

/** Throws a SceneError describing the first problem. */
export function validate(s: Scene): void {
  resolveMaterial(s.material);
  if (s.background !== "transparent") parseHex(s.background);
  if (!(s.exposure > 0 && s.exposure <= 16)) throw new SceneError(`exposure ${s.exposure} outside (0, 16]`);
  if (!(s.camera.fov >= 5 && s.camera.fov <= 120)) throw new SceneError(`camera.fov ${s.camera.fov} outside 5..120`);
  viewDirection(s.camera.view);
  const env = s.environment as Record<string, unknown>;
  if (!["studio", "hdri", "room"].includes(String(env.type))) throw new SceneError("environment.type: studio, hdri or room");
  const i = Number(env.intensity ?? 1);
  if (!(i >= 0 && i <= 20)) throw new SceneError(`environment.intensity ${i} outside 0..20`);
  for (const [k, v] of Object.entries(s.params ?? {})) {
    if (!["number", "boolean", "string"].includes(typeof v)) throw new SceneError(`params.${k}: want a number, boolean or string`);
  }
}

export function resolve(s: Scene): Resolved {
  const env = s.environment as Record<string, unknown>;
  return {
    material: resolveMaterial(s.material),
    environment: {
      type: String(env.type),
      intensity: Number(env.intensity ?? 1),
      rotation_deg: Number(env.rotation_deg ?? 0),
      path: env.type === "hdri" ? String(env.path) : null,
    },
    background: s.background,
    exposure: s.exposure,
    camera: { direction: viewDirection(s.camera.view), fov: s.camera.fov },
  };
}

/** The render request fields for this look (see CONTRACT.md `POST /render`). */
export function renderLook(s: Scene) {
  return {
    materials: s.material !== undefined ? [s.material] : [],
    background: s.background,
    environment: s.environment,
    exposure: s.exposure,
    fov: s.camera.fov,
  };
}
