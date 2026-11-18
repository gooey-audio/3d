// gooey-cad-worker: evaluates Replicad part scripts over a JSON-lines protocol
// on stdio. Spawned by `gooey-3d cad` (crates/cad); one response per request,
// in order. Stdout carries protocol lines only; scripts' console goes to stderr.
//
// On start:  {"ready":true,"protocol":1,"versions":{...},"initMs":N}
//
//   build:  {"id", "op":"build", "script":"/abs/part.js", "params":{...},
//            "allowOutOfRange":false, "tolerance":null|mm, "angularTolerance":0.1,
//            "limits":{"faces":2000,"triangles":2000000},
//            "outputs":{"mesh":"/abs/out.stl", "step":"/abs/out.step"}}
//        -> {"id", "ok":true, "params":{merged}, "valid":bool, "expect":{pieces,genus}|null,
//            "mesh", "step", "triangles", "faceCount", "bounds":{min,max},
//            "tolerance":{"linear","angular"}, "faces":[{face,type,start,count,center,normal}],
//            "ms":{load,eval,check,mesh,step,total}, "jobs", "heapMB", "rssMB"}
//   params: {"id", "op":"params", "script"}
//        -> {"id", "ok":true, "defaultParams":{...}, "paramRanges":{...}}
//   errors: {"id", "ok":false, "error":{kind, message, line?, column?, stack?}}
//           kind: script | syntax | params | kernel | limits | trap | protocol
//
// The host owns timeouts: a kernel operation can loop forever inside WASM and
// no in-process timer can interrupt it. After a WASM trap the module state is
// undefined, so the worker answers and then exits with code 3.
import { createInterface } from "node:readline";
import { loadRuntime } from "./runtime.ts";
import {
  prepareScript,
  importScript,
  mergeParams,
  paramRanges,
  resolveExpect,
  describeError,
  ScriptError,
  type Prepared,
  type Params,
} from "./script.ts";
import { toShape, writeMesh, writeStep, countFaces, adaptiveTolerance, DEFAULT_LIMITS, type Limits } from "./output.ts";
import pkg from "../package.json" with { type: "json" };

/** Bumped on any incompatible change to the request/response shapes. */
const PROTOCOL = 1;

type Request = {
  id?: string | number;
  op?: "build" | "params";
  script: string;
  params?: Params;
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
    prepared = prepareScript(req.script);
    const { module } = await importScript(prepared, rt.replicad);
    if (req.op === "params") {
      return { ok: true, defaultParams: module.defaultParams ?? {}, paramRanges: paramRanges(module) };
    }
    const limits = { ...DEFAULT_LIMITS, ...req.limits };
    const params = mergeParams(module, req.params, req.allowOutOfRange);
    const expect = resolveExpect(module, params);
    const t1 = performance.now();
    const shape = toShape(rt.replicad, await module.main(rt.replicad, { ...params }));
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
    rssMB: Math.round(process.memoryUsage().rss / 2 ** 20),
  });
  if (!res.ok && res.error?.kind === "trap") process.exit(3);
}
