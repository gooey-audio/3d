// Loads a part script as an ES module and runs `main(replicad, params)`.
//
// The script is copied to a uniquely named temp file (so edits and repeated
// builds re-evaluate) after a line-preserving rewrite of `import ... from
// "replicad"` into reads of a global. Line and column numbers in stack traces
// therefore match the user's file; `describeError` swaps the temp path back.
//
// Script conventions (all but `main` optional):
//   export function main(replicad, params) -> shape | shape[] | {shape}
//   export const defaultParams = { name: value, ... }
//   export const paramRanges = { name: [min, max], ... }   (numeric params only)
//   export const expect = { pieces, genus }  or  (params) => ({ pieces, genus })
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
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
export type Expect = { pieces?: number; genus?: number };

export type ScriptModule = {
  main: (replicad: unknown, params: Params) => unknown;
  defaultParams?: Params;
  paramRanges?: Record<string, unknown>;
  expect?: unknown;
  [key: string]: unknown;
};

export type Prepared = { tempPath: string; scriptPath: string };
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

// `import { a, b as c } from "replicad"` -> `const { a, b: c } = globalThis.__gooeyCad.replicad;`
// Each rewrite stays on one line so later line numbers do not move.
function rewriteImports(source: string): string {
  const from = String.raw`\s+from\s+["']replicad["'];?`;
  const g = `globalThis.${GLOBAL}.replicad`;
  return source
    .replace(new RegExp(String.raw`import\s+\*\s+as\s+([\w$]+)` + from, "g"), `const $1 = ${g};`)
    .replace(new RegExp(String.raw`import\s*{([^}]*)}` + from, "g"), (_m, names: string) => {
      const list = names
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.replace(/\s+as\s+/, ": "));
      // Keep the original newline count inside multi-line import lists.
      const pad = "\n".repeat((names.match(/\n/g) ?? []).length);
      return `const { ${list.join(", ")} } = ${g};${pad}`;
    })
    .replace(new RegExp(String.raw`import\s+([\w$]+)` + from, "g"), `const $1 = ${g};`);
}

// Copies the script to a fresh temp module. Kept separate from `importScript`
// so the caller can map errors raised while importing back to the script.
export function prepareScript(scriptPath: string): Prepared {
  let source: string;
  try {
    source = readFileSync(scriptPath, "utf8");
  } catch (err) {
    throw new ScriptError(`cannot read script: ${(err as Error).message}`);
  }
  const ext = extname(scriptPath) === ".ts" ? ".ts" : ".mjs";
  const tempPath = join(tempRoot, `${basename(scriptPath, extname(scriptPath))}-${++counter}${ext}`);
  writeFileSync(tempPath, rewriteImports(source));
  return { tempPath, scriptPath };
}

export async function importScript(prepared: Prepared, replicad: unknown): Promise<Loaded> {
  (globalThis as any)[GLOBAL] = { replicad };
  try {
    let module: ScriptModule;
    try {
      module = (await import(pathToFileURL(prepared.tempPath).href)) as ScriptModule;
    } catch (err) {
      // Node's module loader reports syntax errors without a location; its
      // `--check` mode prints one.
      if (!isBun && err instanceof SyntaxError) (err as any).location ??= nodeCheck(prepared.tempPath);
      throw err;
    }
    if (typeof module.main !== "function") {
      throw new ScriptError("script does not export a function `main(replicad, params)`");
    }
    return { ...prepared, module };
  } finally {
    rmSync(prepared.tempPath, { force: true });
  }
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
  const out: Expect = {};
  for (const [k, v] of Object.entries(e)) {
    if (k !== "pieces" && k !== "genus") throw new ScriptError(`expect.${k}: unknown key (pieces, genus)`);
    if (v === undefined) continue;
    if (!Number.isInteger(v) || (v as number) < 0) throw new ScriptError(`expect.${k} must be a non-negative integer`);
    out[k] = v as number;
  }
  return out;
}

// ------------------------------------------------------------------ errors

export type ErrorInfo = {
  kind: string; // script | syntax | params | kernel | limits | trap | protocol
  message: string;
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
  } else if (isBuildMessage(err)) {
    // Bun reports module parse errors as a BuildMessage, not an Error.
    const { line, column } = (err as any).position; // both 1-based
    const message = `SyntaxError: ${(err as any).message}`;
    info = { kind: "syntax", message, line, column, stack: `${message}\n    at ${loaded?.tempPath}:${line}:${column}` };
  } else if (buildMessages(err).length) {
    // Several parse errors: an AggregateError ("N errors building PATH") of
    // BuildMessages. Point at the first, list them all as `file:line:col: ...`.
    const msgs = buildMessages(err);
    const { line, column } = msgs[0].position;
    const name = loaded ? basename(loaded.scriptPath) : "script";
    const list = msgs.map((m) => `${name}:${m.position.line}:${m.position.column}: ${m.message}`);
    const message = `SyntaxError: ${msgs[0].message}${msgs.length > 1 ? ` (${msgs.length} errors)\n${list.join("\n")}` : ""}`;
    info = { kind: "syntax", message, line, column, stack: `${message}\n    at ${loaded?.tempPath}:${line}:${column}` };
  } else if (err instanceof Error) {
    const kind = err.name === "SyntaxError" ? "syntax" : ((err as ScriptError).kind ?? "script");
    info = { kind, message: err.name === "SyntaxError" ? `SyntaxError: ${err.message}` : err.message, stack: err.stack };
    const at = (err as any).location;
    if (at) Object.assign(info, at);
  } else {
    info = { kind: "script", message: `non-Error thrown: ${String(err)}` };
  }
  if (loaded) {
    const swap = (s: string, to: string) =>
      [pathToFileURL(loaded.tempPath).href, loaded.tempPath].reduce((acc, from) => acc.split(from).join(to), s);
    // Messages name the script by its file name: the host's directories (often
    // temp dirs) are noise. Stacks keep full paths (`locate` reads them).
    const name = basename(loaded.scriptPath);
    info.message = [pathToFileURL(loaded.scriptPath).href, loaded.scriptPath].reduce(
      (acc, from) => acc.split(from).join(name),
      swap(info.message, name),
    );
    if (info.stack) {
      info.stack = swap(info.stack, loaded.scriptPath);
      if (info.line === undefined) {
        const where = locate(info.stack, loaded.scriptPath);
        if (where) Object.assign(info, where);
      }
    }
  }
  return info;
}

function isBuildMessage(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as any).name === "BuildMessage" && !!(err as any).position;
}

type BuildMessage = { message: string; position: { line: number; column: number } };

// The BuildMessages of an AggregateError (Bun, a script with several parse errors).
function buildMessages(err: unknown): BuildMessage[] {
  const errors = err instanceof AggregateError || (err as any)?.name === "AggregateError" ? (err as any).errors : null;
  return Array.isArray(errors) ? (errors.filter(isBuildMessage) as BuildMessage[]) : [];
}

// First stack frame (or SyntaxError header) that points into the user's script.
function locate(stack: string, scriptPath: string): { line: number; column?: number } | undefined {
  const esc = scriptPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = stack.match(new RegExp(`${esc}:(\\d+)(?::(\\d+))?`));
  if (!m) return undefined;
  return { line: Number(m[1]), column: m[2] ? Number(m[2]) : undefined };
}
