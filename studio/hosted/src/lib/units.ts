// Length units. Shared by the server (agent, builds) and the client (viewer, panels).
//
// A part script declares the unit its numbers are in (`export const units = "in"`); the engine
// scales the shape to millimetres before it measures or writes anything, so meshes, STEP files,
// reports and face tables are always mm. The studio-wide setting (`Units`, default inches) picks
// the units of new parts and of every dimension the UI shows.

export const UNITS = ["in", "cm", "mm"] as const;
export type Units = (typeof UNITS)[number];

export const MM_PER_UNIT: Record<Units, number> = { in: 25.4, cm: 10, mm: 1 };

/** The default for new parts and the display: `NEXT_PUBLIC_STUDIO_UNITS`, else inches. Scripts
 *  without a `units` export are built in the engine's default (`GOOEY_UNITS`, else inches). */
export const DEFAULT_UNITS: Units = parseUnits(process.env.NEXT_PUBLIC_STUDIO_UNITS) ?? "in";

export const UNIT_LABELS: Record<Units, string> = { in: "inches", cm: "centimetres", mm: "millimetres" };

export function parseUnits(v: unknown): Units | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (s === "in" || s === "inch" || s === "inches") return "in";
  if (s === "cm" || s.startsWith("centimet")) return "cm";
  if (s === "mm" || s.startsWith("millimet")) return "mm";
  return null;
}

/** The units a script declares (`export const units = "in"`), or null. */
export function declaredUnits(script: string): Units | null {
  const m = script.match(/^\s*export\s+const\s+units\s*=\s*["'`]([^"'`]+)["'`]/m);
  return m ? parseUnits(m[1]) : null;
}

/** The units a part's script is written in: its declaration, else what its last build used,
 *  else the engine default. */
export function partUnits(report: { units?: unknown } | null | undefined, script?: string | null): Units {
  return (script ? declaredUnits(script) : null) ?? (report ? reportUnits(report) : DEFAULT_UNITS);
}

/** A build report's units. Reports from before units existed are millimetres. */
export const reportUnits = (report: { units?: unknown }): Units => parseUnits(report.units) ?? "mm";

/** mm -> `u`. */
export const fromMm = (mm: number, u: Units) => mm / MM_PER_UNIT[u];
/** `u` -> mm. */
export const toMm = (x: number, u: Units) => x * MM_PER_UNIT[u];

/** Decimal places that keep lengths in `u` about as precise as 0.1 mm. */
export const lengthDigits = (u: Units) => (u === "in" ? 3 : u === "cm" ? 2 : 1);

const trim = (s: string) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);

/** A length given in mm, as a number in `u` ("1.25"). */
export function fmtLength(mm: number, u: Units, digits = lengthDigits(u)): string {
  const v = fromMm(mm, u);
  return trim((Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v).toFixed(digits));
}

/** A size given in mm, in `u` ("4.724 × 1.575 × 0.374 in"). */
export function fmtSize(mm: number[], u: Units): string {
  return `${mm.map((x) => fmtLength(x, u)).join(" × ")} ${u}`;
}

/** A volume given in mm³, in `u`³ ("2.3 in³"). */
export function fmtVolume(mm3: number, u: Units): string {
  const v = mm3 / MM_PER_UNIT[u] ** 3;
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : v >= 1 ? 2 : 3;
  return `${trim(v.toFixed(digits))} ${u}³`;
}

/** A round grid step for spacing about `mm`, in mm: 1/2/5 × 10^n of the unit, or for inches
 *  binary fractions (1/16, 1/8, 1/4, 1/2) below one inch. */
export function niceStep(mm: number, u: Units): number {
  const x = fromMm(mm, u);
  if (u === "in" && x < 1) {
    const f = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1].find((s) => x <= s * 1.5) ?? 1;
    return toMm(f, u);
  }
  const p = 10 ** Math.floor(Math.log10(x));
  const m = x / p;
  return toMm((m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p, u);
}

/** A grid step (mm) as a label: "1/4 in", "2 cm", "5 mm". */
export function fmtStep(mm: number, u: Units): string {
  const x = fromMm(mm, u);
  if (u === "in" && x < 1) {
    const d = Math.round(1 / x);
    if (Math.abs(1 / d - x) < 1e-9) return `1/${d} in`;
  }
  return `${fmtLength(mm, u, 4)} ${u}`;
}
