// Run castkit-wasm in Node against the fixtures: every part must match the
// native build's committed report (same numbers; STL hashes reported).
//
//   node crates/castkit-wasm/tests/node.mjs <pkg-dir> <fixtures-dir>
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const [pkg, fixtures] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const t0 = performance.now();
const ck = require(path.resolve(pkg, "castkit_wasm.js"));
console.log(`${ck.version()} loaded in ${(performance.now() - t0).toFixed(0)} ms`);

const close = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a));
function diff(p, a, b, out) {
  const key = p.split(".").pop();
  if (key === "castkit" || key === "kernel") return;
  if (typeof a === "number" && typeof b === "number") { if (!close(a, b)) out.push([p, a, b]); return; }
  if (a && b && typeof a === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(`${p}.${k}`, a[k], b[k], out);
    return;
  }
  if (a !== b) out.push([p, a, b]);
}

let failed = 0, hashes = 0;
for (const name of fs.readdirSync(fixtures).sort()) {
  const dir = path.join(fixtures, name);
  if (!fs.existsSync(path.join(dir, "spec.json"))) continue;
  const spec = fs.readFileSync(path.join(dir, "spec.json"), "utf8");
  const part = fs.readFileSync(path.join(dir, JSON.parse(spec).part));
  const t = performance.now();
  const out = ck.build(spec, part, undefined);
  const ms = performance.now() - t;
  const report = JSON.parse(out.report_json);
  const committed = JSON.parse(fs.readFileSync(path.join(dir, "out/report.json"), "utf8"));
  const d = [];
  diff("", committed, report, d);
  const real = d.filter(([p]) => !p.endsWith("stl_sha256"));
  hashes += d.length - real.length;
  console.log(`${real.length ? "DIFF" : "ok  "} ${name}: ${out.len} parts in ${ms.toFixed(0)} ms, ${d.length - real.length} STL hash differences`);
  for (const r of real) console.log("   ", ...r);
  if (real.length) failed++;
  const rep = JSON.parse(ck.check(out.stl(0), report.material, 256));
  if (rep.ok !== report.parts[0].printability.ok) { console.log("    check() disagrees"); failed++; }
}
console.log(failed ? `${failed} fixtures differ` : `all fixtures match the native build (${hashes} STL hash differences)`);
process.exit(failed ? 1 : 0);
