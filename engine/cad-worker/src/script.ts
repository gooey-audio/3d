// Loads a part script as an ES module and runs `main(replicad, params)`.
//
// The script and its relative imports are copied to a unique temp directory (so edits and repeated
// builds re-evaluate) after a line-preserving rewrite of Replicad and helper imports into reads of a global. Line numbers
// match the original sources; `describeError` maps the temporary paths back.
//
// Script conventions (all but `main` optional):
//   export function main(replicad, params) -> shape | shape[] | {shape}
//   export const units = "in" | "cm" | "mm"   (the script's length unit; else the host's default)
//   export const defaultParams = { name: value, ... }
//   export const paramRanges = { name: [min, max], ... }   (numeric params only)
//   export const expect = { pieces, genus }  or  (params) => ({ pieces, genus })
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isWasmException } from "./kernel-errors.ts";

const GLOBAL = "__gooeyCad";
const isBun = typeof (globalThis as any).Bun !== "undefined";
// realpath: stack traces report /private/var/... for macOS /var/... temp dirs.
// The host points TMPDIR at a directory it owns, so a killed worker leaves
// nothing behind.
const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "cad-worker-")));
process.on("exit", () => rmSync(tempRoot, { recursive: true, force: true }));
let counter = 0;

export type Params = Record<string, unknown>;
export type Ranges = Record<string, [number, number]>;
export type Expect = { pieces?: number; genus?: number; parts?: Record<string, Omit<Expect, "parts">> };

export type ScriptModule = {
  main: (replicad: unknown, params: Params) => unknown;
  defaultParams?: Params;
  paramRanges?: Record<string, unknown>;
  expect?: unknown;
  units?: unknown;
  [key: string]: unknown;
};

// ------------------------------------------------------------------ units

/** Length units a script can be written in. Outputs (STL, STEP, report) are always mm. */
export const MM_PER_UNIT = { in: 25.4, cm: 10, mm: 1 } as const;
export type Units = keyof typeof MM_PER_UNIT;
export const DEFAULT_UNITS: Units = "in";

const UNIT_ALIASES: Record<string, Units> = {
  in: "in", inch: "in", inches: "in", '"': "in",
  cm: "cm", centimeter: "cm", centimeters: "cm", centimetre: "cm", centimetres: "cm",
  mm: "mm", millimeter: "mm", millimeters: "mm", millimetre: "mm", millimetres: "mm",
};

/** A unit name (or alias) as a `Units`, or null. */
export function parseUnits(v: unknown): Units | null {
  return typeof v === "string" ? (UNIT_ALIASES[v.trim().toLowerCase()] ?? null) : null;
}

/** The script's `units` export, else `fallback` (the host's default). */
export function scriptUnits(module: ScriptModule, fallback: Units = DEFAULT_UNITS): Units {
  if (module.units === undefined || module.units === null) return fallback;
  const u = parseUnits(module.units);
  if (!u) throw new ScriptError(`\`units\` must be "in", "cm" or "mm", got ${JSON.stringify(module.units)}`);
  return u;
}

export type Prepared = { dir: string; tempPath: string; sources: Map<string, string>; declaredUnits?: Units };
export type Loaded = Prepared & { module: ScriptModule };

// Plain field assignment, not a parameter property: Node's type stripping
// (the fallback runtime) rejects TypeScript-only syntax.
export class ScriptError extends Error {
  kind: string;
  constructor(message: string, kind = "script") {
    super(message);
    this.kind = kind;
  }
}

// Skip comments and quoted source text when looking for import statements.
const comments = String.raw`//[^\n]*|/\*[\s\S]*?\*/`;
const quoted = String.raw`"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|` +
  "`(?:\\\\[\\s\\S]|[^`\\\\])*`";
const trivia = String.raw`(?:\s|${comments})`;

// Preserve the newline count of the complete import, including a wrapped "from".
function rewriteImports(source: string): string {
  const imports = new RegExp(
    `${comments}|${quoted}|` + String.raw`\bimport${trivia}*(?<binding>\*\s+as\s+[\w$]+|{[^}]*}|[\w$]+)${trivia}*from${trivia}*["'](?<mod>replicad|gooey-3d)["'];?`,
    "g",
  );
  return source.replace(imports, (match, binding, mod) => {
    if (!mod) return match;
    const target = `globalThis.${GLOBAL}.${mod === "replicad" ? mod : "gooey"}`;
    const pad = "\n".repeat((match.match(/\n/g) ?? []).length);
    if (!binding.startsWith("{")) {
      const local = binding.split(/\s+/).at(-1);
      return `const ${local} = ${target};${pad}`;
    }
    const list = binding.slice(1, -1).replace(new RegExp(comments, "g"), "").split(",")
      .map((s: string) => s.trim().replace(/\s+as\s+/, ": "))
      .filter(Boolean);
    return `const { ${list.join(", ")} } = ${target};${pad}`;
  });
}

export function prepareScript(scriptPath: string): Prepared {
  scriptPath = resolve(scriptPath);
  const files = new Map<string, string>();
  // Import declarations, re-exports and literal import() calls use the same
  // specifier in the mirrored tree, including cycles.
  const imports = new RegExp(
    `${comments}|${quoted}|` + String.raw`(?:\bfrom${trivia}*|\bimport${trivia}*(?:\(${trivia}*)?)(["'])(\.\.?\/[^"'\n]+)\1`,
    "g",
  );
  function visit(path: string) {
    if (files.has(path)) return;
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch (err) {
      const error = new ScriptError(`cannot read script: ${(err as Error).message}`);
      Object.assign(error, { location: { file: path } });
      throw error;
    }
    files.set(path, source);
    for (const [, , specifier] of source.matchAll(imports)) {
      if (specifier) visit(resolve(dirname(path), specifier));
    }
  }
  visit(scriptPath);
  let root = dirname(scriptPath);
  for (const path of files.keys()) {
    while (relative(root, path).startsWith(`..${sep}`)) root = dirname(root);
  }
  const dir = join(tempRoot, String(++counter));
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  const sources = new Map<string, string>();
  // Keep control files outside the mirrored tree so a local package.json is
  // safe to import as data.
  const tree = join(dir, "src");
  try {
    for (const [path, source] of files) {
      const dest = join(tree, relative(root, path));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, rewriteImports(source));
      sources.set(dest, path);
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  const unitDeclaration = new RegExp(
    `${comments}|${quoted}|` + String.raw`\bexport${trivia}+const${trivia}+units${trivia}*=${trivia}*["']([^"']+)["'](?=\s*(?:;|$|as\b|satisfies\b))`,
    "gm",
  );
  const [, declared] = [...files.get(scriptPath)!.matchAll(unitDeclaration)].find((match) => match[1]) ?? [];
  return {
    dir, sources, tempPath: join(tree, relative(root, scriptPath)),
    declaredUnits: parseUnits(declared) ?? undefined,
  };
}

export async function importScript(prepared: Prepared, replicad: unknown, gooey: unknown): Promise<Loaded> {
  (globalThis as any)[GLOBAL] = { replicad, gooey };
  let module: ScriptModule;
  try {
    module = (await import(pathToFileURL(prepared.tempPath).href)) as ScriptModule;
  } catch (err) {
    // Node's module loader reports syntax errors without a location.
    if (!isBun && err instanceof SyntaxError) {
      for (const [temp, file] of prepared.sources) {
        const where = nodeCheck(temp);
        if (where) {
          (err as any).location ??= { file, ...where };
          break;
        }
      }
    }
    throw err;
  }
  if (typeof module.main !== "function") {
    throw new ScriptError("script does not export a function `main(replicad, params)`");
  }
  return { ...prepared, module };
}

// `node --check FILE` prints `FILE:LINE`, the source line and a caret row.
function nodeCheck(path: string): { line: number; column?: number } | undefined {
  const r = spawnSync(process.execPath, ["--check", path], { encoding: "utf8", timeout: 5000 });
  const lines = (r.stderr ?? "").split("\n");
  const at = lines.findIndex((l) => l.startsWith(`${path}:`));
  if (at < 0) return undefined;
  const line = Number(lines[at].slice(path.length + 1));
  if (!Number.isInteger(line)) return undefined;
  const caret = lines[at + 2]?.indexOf("^") ?? -1;
  return { line, column: caret >= 0 ? caret + 1 : undefined };
}

// ------------------------------------------------------------------ params

// The script's `paramRanges`, checked: each entry names a numeric default and
// is a finite `[min, max]` with min <= max.
export function paramRanges(module: ScriptModule): Ranges {
  const defaults = module.defaultParams ?? {};
  const raw = module.paramRanges ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ScriptError("`paramRanges` must be an object of `name: [min, max]`");
  }
  const ranges: Ranges = {};
  for (const [name, r] of Object.entries(raw)) {
    if (!(name in defaults)) throw new ScriptError(`paramRanges.${name}: no such entry in defaultParams`);
    if (typeof defaults[name] !== "number") throw new ScriptError(`paramRanges.${name}: the default is not a number`);
    if (!Array.isArray(r) || r.length !== 2 || !r.every((v) => typeof v === "number" && Number.isFinite(v)) || r[0] > r[1]) {
      throw new ScriptError(`paramRanges.${name} must be [min, max] with finite min <= max`);
    }
    ranges[name] = [r[0], r[1]];
  }
  return ranges;
}

function coerce(name: string, def: unknown, value: unknown): unknown {
  const bad = (want: string) =>
    new ScriptError(`parameter \`${name}\` must be ${want}, got ${JSON.stringify(value)}`, "params");
  if (typeof value !== "string" || typeof def === "string") {
    if (typeof def === "number" && typeof value !== "number") throw bad("a number");
    if (typeof def === "boolean" && typeof value !== "boolean") throw bad("true or false");
    return value;
  }
  // Strings come from `--set name=value`: read them as the default's type.
  if (typeof def === "number") {
    const n = value.trim() === "" ? NaN : Number(value);
    if (Number.isNaN(n)) throw bad("a number");
    return n;
  }
  if (typeof def === "boolean") {
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
    throw bad("true or false");
  }
  try {
    return JSON.parse(value);
  } catch {
    throw bad("JSON");
  }
}

// `{...defaultParams, ...overrides}`: unknown names are rejected, `--set`
// strings are read as the default's type, numbers must be finite, and numeric
// params must lie within `paramRanges` unless `allowOutOfRange`.
export function mergeParams(module: ScriptModule, overrides: Params = {}, allowOutOfRange = false): Params {
  const defaults = module.defaultParams ?? {};
  const ranges = paramRanges(module);
  const params: Params = { ...defaults };
  for (const [name, value] of Object.entries(overrides)) {
    if (!(name in defaults)) {
      const known = Object.keys(defaults).join(", ") || "(none)";
      throw new ScriptError(`unknown parameter \`${name}\` (known: ${known})`, "params");
    }
    params[name] = coerce(name, defaults[name], value);
  }
  for (const [name, value] of Object.entries(params)) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new ScriptError(`parameter \`${name}\` must be finite, got ${value}`, "params");
    }
    const r = ranges[name];
    if (r && !allowOutOfRange && typeof value === "number" && (value < r[0] || value > r[1])) {
      throw new ScriptError(
        `parameter \`${name}\` = ${value} is outside paramRanges [${r[0]}, ${r[1]}] (pass --allow-out-of-range to build anyway)`,
        "params",
      );
    }
  }
  return params;
}

// The script's `expect` (an object, or a function of the merged params), checked.
export function resolveExpect(module: ScriptModule, params: Params): Expect | null {
  let e = module.expect;
  if (e === undefined || e === null) return null;
  if (typeof e === "function") e = e({ ...params });
  if (typeof e !== "object" || e === null || Array.isArray(e)) {
    throw new ScriptError("`expect` must be an object like { pieces: 1, genus: 4 } or a function returning one");
  }
  return parseExpect(e, "expect", true);
}

function parseExpect(e: object, label: string, allowParts: boolean): Expect {
  const out: Expect = {};
  for (const [k, v] of Object.entries(e)) {
    if (k === "parts" && allowParts) {
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new ScriptError(`${label}.parts must be an object`);
      out.parts = Object.fromEntries(Object.entries(v).map(([name, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new ScriptError(`${label}.parts.${name} must be an object`);
        }
        return [name, parseExpect(value, `${label}.parts.${name}`, false)];
      }));
      continue;
    }
    if (k !== "pieces" && k !== "genus") throw new ScriptError(`${label}.${k}: unknown key`);
    if (v === undefined) continue;
    if (!Number.isInteger(v) || (v as number) < 0) throw new ScriptError(`${label}.${k} must be a non-negative integer`);
    out[k] = v as number;
  }
  return out;
}

// ------------------------------------------------------------------ errors

export type ErrorInfo = {
  kind: string; // script | syntax | params | kernel | limits | trap | protocol
  message: string;
  file?: string;
  line?: number;
  column?: number;
  stack?: string;
};

// Converts anything thrown while loading or running a script into ErrorInfo.
// OpenCascade C++ exceptions arrive as `WebAssembly.Exception` (the 1.x build
// uses native WASM exception handling); `oc.getExceptionMessage` decodes them.
// Exceptions that crossed a replicad call already are `KernelError`s with a
// JavaScript stack (kernel-errors.ts).
export function describeError(err: unknown, oc: any, loaded?: Prepared): ErrorInfo {
  let info: ErrorInfo;
  if (isWasmException(err)) {
    let type = "C++ exception";
    let message = "";
    try {
      [type, message] = oc.getExceptionMessage(err);
      oc.decrementExceptionRefcount?.(err);
    } catch {}
    info = { kind: "kernel", message: `OpenCascade ${type}${message ? `: ${message}` : ""}`, stack: (err as any).stack };
  } else if (err instanceof WebAssembly.RuntimeError) {
    info = { kind: "trap", message: `WASM trap: ${err.message}`, stack: err.stack };
  } else if (isBuildMessage(err) || buildMessages(err).length) {
    const msgs = isBuildMessage(err) ? [err as BuildMessage] : buildMessages(err);
    const { file, line, column } = msgs[0].position;
    const list = msgs.map((m) => {
      const p = m.position;
      return `${basename(loaded?.sources.get(p.file ?? "") ?? p.file ?? "script")}:${p.line}:${p.column}: ${m.message}`;
    });
    const message = `SyntaxError: ${msgs[0].message}${msgs.length > 1 ? ` (${msgs.length} errors)\n${list.join("\n")}` : ""}`;
    info = { kind: "syntax", message, line, column, file: loaded?.sources.get(file ?? "") };
  } else if (err instanceof Error) {
    const kind = err.name === "SyntaxError" ? "syntax" : ((err as ScriptError).kind ?? "script");
    info = { kind, message: err.name === "SyntaxError" ? `SyntaxError: ${err.message}` : err.message, stack: err.stack };
    const at = (err as any).location;
    if (at) Object.assign(info, at);
  } else {
    info = { kind: "script", message: `non-Error thrown: ${String(err)}` };
  }
  if (loaded) {
    if (info.stack && info.line === undefined) Object.assign(info, locate(info.stack, loaded.sources));
    for (const [temp, source] of loaded.sources) {
      for (const from of [pathToFileURL(temp).href, temp]) {
        info.message = info.message.split(from).join(basename(source));
        if (info.stack) info.stack = info.stack.split(from).join(source);
      }
    }
  }
  return info;
}

function isBuildMessage(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as any).name === "BuildMessage" && !!(err as any).position;
}

type BuildMessage = { message: string; position: { file?: string; line: number; column: number } };

// The BuildMessages of an AggregateError (Bun, a script with several parse errors).
function buildMessages(err: unknown): BuildMessage[] {
  const errors = err instanceof AggregateError || (err as any)?.name === "AggregateError" ? (err as any).errors : null;
  return Array.isArray(errors) ? (errors.filter(isBuildMessage) as BuildMessage[]) : [];
}

// First stack frame (or SyntaxError header) that points into the user's script.
function locate(stack: string, sources: Map<string, string>): Pick<ErrorInfo, "file" | "line" | "column"> {
  let first = Infinity;
  let location = {};
  for (const [temp, file] of sources) {
    for (const path of [temp, pathToFileURL(temp).href]) {
      const esc = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const m = stack.match(new RegExp(`${esc}:(\\d+)(?::(\\d+))?`));
      if (m && m.index! < first) {
        first = m.index!;
        location = { file, line: Number(m[1]), column: m[2] ? Number(m[2]) : undefined };
      }
    }
  }
  return location;
}
