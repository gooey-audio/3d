// The build report's printability `fails` (engine/crates/castkit-core/src/check.rs), explained
// for people: a title, what it means, how to fix it, and where it is (for the viewer's marks).
// The check assumes FDM printing of the part as modelled: Z up, lowest point on the bed.

export type PostMark = { at: [number, number]; height: number; width: number };
/** `thin`: runs of section heights (z mm, from, to) the check found too thin. */
export type PrintMarks = { overhangs: boolean; thin: [number, number][]; posts: PostMark[] };

export type PrintIssue = {
  title: string;
  what: string;
  fix: string;
  /** The engine's message (the item's tooltip). */
  raw: string;
  /** How the viewer shows it, when it can. */
  shown?: string;
};

/** check.rs `Material::limits`. */
const LIMITS: Record<string, { postRatio: number; minWall: number; overhangCm2: number; bridgeMm: number }> = {
  pla: { postRatio: 8, minWall: 1.6, overhangCm2: 3, bridgeMm: 20 },
  tpu: { postRatio: 3, minWall: 2, overhangCm2: 0.5, bridgeMm: 0 },
};

const num = (s: string) => Number(s);
const fmtZ = (z: number) => String(Math.round(z * 10) / 10);

/** Groups the check's section heights (one every 0.5 mm, check.rs `LAYER`) into runs. */
function runs(zs: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const z of [...zs].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && z - last[1] <= 0.5 + 1e-6) last[1] = z;
    else out.push([z, z]);
  }
  return out;
}

export function explain(fails: string[], material = "pla"): { issues: PrintIssue[]; marks: PrintMarks } {
  const lim = LIMITS[material] ?? LIMITS.pla;
  const marks: PrintMarks = { overhangs: false, thin: [], posts: [] };
  const issues = fails.map((raw): PrintIssue => {
    let m: RegExpMatchArray | null;
    if (raw === "mesh is not closed")
      return {
        raw,
        title: "Not watertight",
        what: "The surface has gaps or open edges, so a slicer cannot tell inside from outside.",
        fix: "Make sure every boolean leaves one closed solid; avoid faces that only just touch.",
      };
    if ((m = raw.match(/^(\d+) separate pieces$/)))
      return {
        raw,
        title: `${m[1]} separate pieces`,
        what: "The part is several bodies that do not touch; they print as loose pieces.",
        fix: "Union them, connect them with material, or make them separate parts on purpose.",
      };
    if (raw.includes("vertex pairs closer than"))
      return {
        raw,
        title: "Coincident faces",
        what: "Faces that exactly touch (a cut flush with a face, tangent shapes) leave slivers a slicer can mis-read.",
        fix: "Make cuts and unions overlap by 0.01–0.1 mm instead of ending exactly on a face.",
      };
    if ((m = raw.match(/^does not fit the (\S+) mm bed$/)))
      return {
        raw,
        title: "Too big for the bed",
        what: `One side is longer than the ${m[1]} mm print bed.`,
        fix: "Make it smaller or split it into parts that are joined after printing.",
      };
    if (raw.includes("footprint is on the bed"))
      return {
        raw,
        title: "Not sitting flat",
        what: "Under 30 % of the footprint touches the bed (the part prints as modelled, lowest Z down).",
        fix: "Give it a large flat face at the lowest Z, or rotate it so one is there.",
      };
    if ((m = raw.match(/^(\S+) cm² of overhang steeper than (\S+) deg$/))) {
      marks.overhangs = true;
      const bridges = lim.bridgeMm ? ` Flat ceilings up to ${lim.bridgeMm} mm across bridge fine.` : "";
      return {
        raw,
        title: "Steep overhangs",
        what: `${m[1]} cm² of downward-facing surface is steeper than ${m[2]}° and would print over air (${material.toUpperCase()} allows up to ${lim.overhangCm2} cm²).`,
        fix: `Chamfer the undersides to 45° or less, rotate the part, or split it.${bridges}`,
        shown: lim.bridgeMm ? "red in the view; flat ceilings amber" : "red in the view",
      };
    }
    if ((m = raw.match(/^free-standing post at \[(\S+), (\S+)\] is (\S+) mm tall and (\S+) mm wide/))) {
      marks.posts.push({ at: [num(m[1]), num(m[2])], height: num(m[3]), width: num(m[4]) });
      return {
        raw,
        title: "Tall, thin post",
        what: `A post at (${m[1]}, ${m[2]}) mm is ${m[3]} mm tall and only ${m[4]} mm wide: over ${lim.postRatio}:1, so it wobbles or snaps while printing.`,
        fix: "Make it wider or shorter, add a fillet or gusset at its base, or swap it for a steel pin or a hole to drill.",
        shown: "red line in the view",
      };
    }
    if ((m = raw.match(/^sections thinner than (\S+) mm at z = \[(.*)\]$/))) {
      const zs = m[2].split(",").map((s) => num(s.trim())).filter(Number.isFinite);
      const rs = runs(zs);
      marks.thin.push(...rs);
      const at = rs.map(([a, b]) => (a === b ? fmtZ(a) : `${fmtZ(a)}–${fmtZ(b)}`)).join(", ");
      return {
        raw,
        title: "Thin walls",
        what: `At z = ${at} mm part of the cross-section is thinner than ${m[1]} mm, too thin to print reliably.`,
        fix: `Thicken those walls or features to at least ${m[1]} mm.`,
        shown: "red bands in the view",
      };
    }
    if (raw.startsWith("kernel rejected the mesh"))
      return {
        raw,
        title: "Invalid solid",
        what: "The geometry kernel could not read the mesh as a solid, so the deeper checks were skipped.",
        fix: "Look for self-intersections or zero-thickness geometry.",
      };
    return { raw, title: "Print issue", what: raw, fix: "" };
  });
  return { issues, marks };
}
