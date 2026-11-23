// gooey-cad-worker: evaluates Replicad part scripts over a JSON-lines protocol
// on stdio. Spawned by `gooey-3d cad` (crates/cad); one response per request,
// in order. Stdout carries protocol lines only; scripts' console goes to stderr.
//
// On start:  {"ready":true,"protocol":1,"versions":{...},"initMs":N}
//
//   build:  {"id", "op":"build", "script":"/abs/part.js", "params":{...}, "units":"in"|"cm"|"mm",
//            "allowOutOfRange":false, "tolerance":null|mm, "angularTolerance":0.1,
//            "limits":{"faces":2000,"triangles":2000000},
//            "outputs":{"mesh":"/abs/out.stl", "step":"/abs/out.step"}}
//        -> {"id", "ok":true, "params":{merged}, "units", "mmPerUnit", "valid":bool, "expect":{pieces,genus}|null,
//            "mesh", "step", "triangles", "faceCount", "bounds":{min,max},
//            "tolerance":{"linear","angular"}, "faces":[{face,type,start,count,center,normal}],
//            "ms":{load,eval,check,mesh,step,total}, "jobs", "heapMB", "rssMB"|null}
//   params: {"id", "op":"params", "script", "units"}
//        -> {"id", "ok":true, "defaultParams":{...}, "paramRanges":{...}, "units"}
//   errors: {"id", "ok":false, "error":{kind, message, line?, column?, stack?}}
//           kind: script | syntax | params | kernel | limits | trap | protocol
//
// `units` in a request is the default for scripts without `export const units`
// (default "in"). The script's numbers are in its units; the shape is scaled to
// mm before anything is measured or written, so meshes, STEP files, bounds and
// the face table are always mm.
//
// The host owns timeouts: a kernel operation can loop forever inside WASM and
// no in-process timer can interrupt it. After a WASM trap the module state is
// undefined, so the worker answers and then exits with code 3.
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeGooey, type Part } from "./gooey.ts";
import { createInterface } from "node:readline";
import { loadRuntime } from "./runtime.ts";
import {
  prepareScript,
  importScript,
  mergeParams,
  paramRanges,
  resolveExpect,
  scriptUnits,
  parseUnits,
  DEFAULT_UNITS,
  MM_PER_UNIT,
  describeError,
  ScriptError,
  type Prepared,
  type Params,
} from "./script.ts";
import { assemblyParts, combineMeshes, toShape, writeMesh, writeStep, countFaces, adaptiveTolerance, DEFAULT_LIMITS, type Limits, type FaceGroup } from "./output.ts";
import pkg from "../package.json" with { type: "json" };

/** Bumped on any incompatible change to the request/response shapes. */
const PROTOCOL = 1;

type Request = {
  id?: string | number;
  op?: "build" | "params";
  script: string;
  params?: Params;
  units?: string | null;
  allowOutOfRange?: boolean;
  tolerance?: number | null;
  angularTolerance?: number;
  limits?: Partial<Limits>;
  outputs?: { mesh?: string; step?: string };
};

const VERSIONS = {
  worker: pkg.version,
  replicad: pkg.dependencies.replicad,
  opencascade: pkg.dependencies["replicad-opencascadejs"],
  manifold: pkg.dependencies["manifold-3d"],
  engine: typeof (globalThis as any).Bun !== "undefined" ? `bun ${(globalThis as any).Bun.version}` : `node ${process.versions.node}`,
};

if (process.argv.includes("--version")) {
  process.stdout.write(JSON.stringify({ protocol: PROTOCOL, versions: VERSIONS }) + "\n");
  process.exit(0);
}

// Deep replicad call chains would otherwise push the script's frame off the stack.
Error.stackTraceLimit = 64;

// Scripts that print would corrupt the protocol stream: route console to stderr.
for (const level of ["log", "info", "warn", "debug"] as const) console[level] = console.error;
const send = (msg: object) => process.stdout.write(JSON.stringify(msg) + "\n");

const rt = await loadRuntime();
send({ ready: true, protocol: PROTOCOL, versions: VERSIONS, initMs: Math.round(rt.initMs) });

const round1 = (x: number) => Math.round(x * 10) / 10;

async function handle(req: Request): Promise<{ ok: boolean; [k: string]: any }> {
  const t0 = performance.now();
  let prepared: Prepared | undefined;
  try {
    if (!req || typeof req.script !== "string") throw new ScriptError("request needs a `script` path", "protocol");
    if (req.op !== "build" && req.op !== "params") throw new ScriptError(`unknown op ${JSON.stringify(req.op)}`, "protocol");
    const fallback = req.units == null ? DEFAULT_UNITS : parseUnits(req.units);
    if (!fallback) throw new ScriptError(`units must be "in", "cm" or "mm", got ${JSON.stringify(req.units)}`, "protocol");
    prepared = prepareScript(req.script);
    const gooey = makeGooey(rt.replicad, prepared.declaredUnits ?? fallback);
    const { module } = await importScript(prepared, rt.replicad, gooey);
    const units = scriptUnits(module, fallback);
    gooey.units = units;
    if (req.op === "params") {
      return { ok: true, defaultParams: module.defaultParams ?? {}, paramRanges: paramRanges(module), units };
    }
    const limits = { ...DEFAULT_LIMITS, ...req.limits };
    const params = mergeParams(module, req.params, req.allowOutOfRange);
    const expect = resolveExpect(module, params);
    const t1 = performance.now();
    const result = await module.main(rt.replicad, { ...params });
    const parts = assemblyParts(result);
    if (parts) return await buildAssembly(req, parts, result, { params, units, expect }, limits, t0, t1);
    let shape = toShape(rt.replicad, result);
    // Everything downstream (mesh, STEP, bounds, faces, tolerances) is in mm.
    const mmPerUnit = MM_PER_UNIT[units];
    if (mmPerUnit !== 1) shape = shape.scale(mmPerUnit, [0, 0, 0]);
    const t2 = performance.now();
    try {
      // Cheap guards before tessellation, the step that blows up.
      const faceCount = countFaces(rt.oc, shape, limits.faces);
      if (faceCount > limits.faces) {
        throw new ScriptError(`the shape has more than ${limits.faces} B-rep faces`, "limits");
      }
      // OpenCascade can "succeed" with a broken solid (e.g. a fillet larger than
      // the faces it joins), so the B-rep is checked; the host fails on `valid:false`.
      const valid = isValidSolid(rt.oc, shape);
      const auto = adaptiveTolerance(shape);
      const linear = req.tolerance ?? auto.tolerance;
      const angular = req.angularTolerance ?? 0.1;
      const out: Record<string, unknown> = {
        ok: true,
        params,
        units,
        mmPerUnit,
        expect,
        valid,
        faceCount,
        tolerance: { linear, angular },
      };
      const ms: Record<string, number> = { load: t1 - t0, eval: t2 - t1, check: performance.now() - t2 };
      if (req.outputs?.mesh) {
        const t3 = performance.now();
        const m = writeMesh(shape, req.outputs.mesh, linear, angular, limits.triangles);
        Object.assign(out, { mesh: req.outputs.mesh, triangles: m.triangles, bounds: m.bounds, faces: m.faces });
        ms.mesh = performance.now() - t3;
      }
      if (req.outputs?.step) {
        const t4 = performance.now();
        await writeStep(shape, req.outputs.step);
        out.step = req.outputs.step;
        ms.step = performance.now() - t4;
      }
      ms.total = performance.now() - t0;
      for (const k in ms) ms[k] = round1(ms[k]);
      return { ...out, ok: true, ms };
    } finally {
      shape.delete?.();
    }
  } catch (err) {
    return { ok: false, error: describeError(err, rt.oc, prepared) };
  } finally {
    if (prepared) rmSync(prepared.dir, { recursive: true, force: true });
  }
}

async function buildAssembly(
  req: Request, parts: Part[], result: unknown,
  script: { params: Params; units: keyof typeof MM_PER_UNIT; expect: ReturnType<typeof resolveExpect> },
  limits: Limits, t0: number, t1: number,
) {
  const mmPerUnit = MM_PER_UNIT[script.units];
  const shapes = new Set<{ delete(): void }>(parts.map((p) => p.shape));
  try {
    const named = parts.map(({ shape, ...part }) => {
      const scaled = mmPerUnit === 1 ? shape : shape.clone().scale(mmPerUnit, [0, 0, 0]);
      shapes.add(scaled);
      return { ...part, shape: scaled };
    });
    const compound = rt.replicad.makeCompound(named.map((p) => p.shape.clone()));
    shapes.add(compound);
    const t2 = performance.now();
    let faceCount = 0;
    const checks = named.map(({ name, shape }) => {
      const count = countFaces(rt.oc, shape, limits.faces - faceCount);
      faceCount += count;
      if (faceCount > limits.faces) throw new ScriptError(`the assembly has more than ${limits.faces} B-rep faces`, "limits");
      return { name, faceCount: count, valid: isValidSolid(rt.oc, shape) };
    });
    const tolerance = { linear: req.tolerance ?? adaptiveTolerance(compound).tolerance, angular: req.angularTolerance ?? 0.1 };
    const t3 = performance.now();
    const meshDir = req.outputs?.mesh && join(dirname(req.outputs.mesh), "parts");
    const stepDir = req.outputs?.step && join(dirname(req.outputs.step), "parts");
    for (const dir of new Set([meshDir, stepDir])) if (dir) mkdirSync(dir, { recursive: true });
    const faces: FaceGroup[] = [];
    const meshPaths: string[] = [];
    const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    let triangles = 0;
    let faceOffset = 0;
    const outputs = named.map(({ shape, ...part }, i) => {
      const check = checks[i];
      const { explode } = part;
      const entry = { ...part, explode: explode?.map((x) => x * mmPerUnit), ...check };
      if (!meshDir || !check.valid) return entry;
      const mesh = join(meshDir, `${part.name}.stl`);
      const m = writeMesh(shape, mesh, tolerance.linear, tolerance.angular, limits.triangles - triangles);
      for (const face of m.faces) {
        faces.push({ ...face, face: face.face < 0 ? face.face : face.face + faceOffset, start: face.start + triangles });
      }
      faceOffset += check.faceCount;
      triangles += m.triangles;
      for (let k = 0; k < 3; k++) {
        bounds.min[k] = Math.min(bounds.min[k], m.bounds.min[k]);
        bounds.max[k] = Math.max(bounds.max[k], m.bounds.max[k]);
      }
      meshPaths.push(mesh);
      return { ...entry, mesh, triangles: m.triangles, bounds: m.bounds };
    });
    const valid = checks.every((p) => p.valid);
    if (valid && req.outputs?.mesh) combineMeshes(meshPaths, triangles, req.outputs.mesh);
    const t4 = performance.now();
    if (valid && stepDir && req.outputs?.step) {
      for (const [i, p] of named.entries()) {
        const step = join(stepDir, `${p.name}.step`);
        await writeStep(p.shape, step);
        Object.assign(outputs[i], { step });
      }
      await writeStep(compound, req.outputs.step, named.map(({ name, shape }) => ({ name, shape })), rt.replicad);
    }
    const ms = {
      load: round1(t1 - t0), eval: round1(t2 - t1), check: round1(t3 - t2), mesh: round1(t4 - t3),
      ...(stepDir ? { step: round1(performance.now() - t4) } : {}), total: round1(performance.now() - t0),
    };
    return {
      ok: true, ...script, mmPerUnit, valid, faceCount, tolerance, faces, triangles, bounds,
      mesh: req.outputs?.mesh, step: req.outputs?.step, parts: outputs,
      assemblyName: (result as { name?: string }).name, ms,
    };
  } finally {
    for (const shape of shapes) shape.delete();
  }
}

function isValidSolid(oc: any, shape: any): boolean {
  const analyzer = new oc.BRepCheck_Analyzer(shape.wrapped, true, false);
  try {
    return analyzer.IsValid();
  } finally {
    analyzer.delete();
  }
}

// `process.memoryUsage()` can throw "SystemError: Failed to get memory usage"
// (EINTR) on Linux; retry once, else report null rather than die.
function rssMB(): number | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return Math.round(process.memoryUsage().rss / 2 ** 20);
    } catch {}
  }
  return null;
}

let jobs = 0;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  let req: Request;
  try {
    req = JSON.parse(line);
  } catch (err) {
    send({ id: null, ok: false, error: { kind: "protocol", message: `bad JSON request: ${(err as Error).message}` } });
    continue;
  }
  const res = await handle(req);
  jobs++;
  send({
    id: req.id ?? null,
    ...res,
    jobs,
    heapMB: Math.round(rt.oc.wasmMemory.buffer.byteLength / 2 ** 20),
    rssMB: rssMB(),
  });
  if (!res.ok && res.error?.kind === "trap") process.exit(3);
}
