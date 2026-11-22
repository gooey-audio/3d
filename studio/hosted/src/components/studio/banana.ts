// Banana for scale: a procedural Cavendish banana at life size (mm, Y up), lying on its side
// on the ground. It is swept along a gently curved spine with a rounded-pentagon cross-section
// (the ridges), a thin stem at one end and a dark tip at the other, coloured per vertex.

import * as THREE from "three";

/** Spine (centreline) length, mm: a medium Cavendish is about 19 cm along the outer curve. */
export const BANANA_LENGTH_MM = 185;
const BEND = 1.0; // radians of curvature over the length
const MAX_R = 18; // mm, half the widest diameter
const STEM = 0.1; // fraction of the length that is stem
const RIDGES = 5;
const SEGMENTS = 96; // along the length
const SIDES = 40; // around

const YELLOW = new THREE.Color().setRGB(0.95, 0.78, 0.2, THREE.SRGBColorSpace);
const GREENISH = new THREE.Color().setRGB(0.62, 0.62, 0.16, THREE.SRGBColorSpace);
const STEM_GREEN = new THREE.Color().setRGB(0.38, 0.4, 0.14, THREE.SRGBColorSpace);
const STEM_CUT = new THREE.Color().setRGB(0.42, 0.34, 0.18, THREE.SRGBColorSpace);
const TIP = new THREE.Color().setRGB(0.16, 0.11, 0.06, THREE.SRGBColorSpace);

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Radius (mm) and colour at `t` (0: stem end, 1: tip). */
function profile(t: number, out: THREE.Color): number {
  if (t < STEM) {
    out.copy(STEM_GREEN);
    return 4.2 + 1.2 * smooth(0, STEM, t);
  }
  const u = (t - STEM) / (1 - STEM);
  const f = Math.sin(Math.PI * Math.min(1, Math.max(0, u))) ** 0.42;
  out.copy(GREENISH).lerp(YELLOW, smooth(0, 0.35, u)).lerp(TIP, smooth(0.965, 0.99, u));
  return u < 0.5 ? 5.4 + (MAX_R - 5.4) * f : 3.2 + (MAX_R - 3.2) * f;
}

/** A banana mesh: long axis along X (stem at -X), bowed toward -Z, resting on y = 0 and
 *  centred on the origin in X and Z. Casts shadows; not pickable (the viewer raycasts the part). */
export function makeBanana(): THREE.Mesh {
  const arcR = BANANA_LENGTH_MM / BEND;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const c = new THREE.Color();

  const center = (t: number) => {
    const a = (t - 0.5) * BEND;
    return new THREE.Vector3(arcR * Math.sin(a), 0, arcR * (1 - Math.cos(a)));
  };
  // Frame: tangent along the spine, `side` in the XZ plane (outward from the bend), up = Y.
  const side = (t: number) => {
    const a = (t - 0.5) * BEND;
    return new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
  };

  for (let i = 0; i <= SEGMENTS; i++) {
    const t = i / SEGMENTS;
    const r = profile(t, c);
    const p = center(t);
    const s = side(t);
    // Ridges fade in from the stem and soften toward the tip.
    const ridge = t < STEM ? 0 : 0.07 * smooth(STEM, STEM + 0.12, t);
    for (let j = 0; j < SIDES; j++) {
      const phi = (j / SIDES) * Math.PI * 2;
      const rr = r * (1 + ridge * Math.cos(RIDGES * phi));
      pos.push(
        p.x + s.x * Math.cos(phi) * rr,
        p.y + Math.sin(phi) * rr,
        p.z + s.z * Math.cos(phi) * rr,
      );
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < SEGMENTS; i++) {
    for (let j = 0; j < SIDES; j++) {
      const a = i * SIDES + j;
      const b = i * SIDES + ((j + 1) % SIDES);
      const a2 = a + SIDES;
      const b2 = b + SIDES;
      idx.push(a, a2, b, b, a2, b2);
    }
  }
  // End caps: a fan to the centre of each end ring, in their own vertices so the cut is crisp.
  const cap = (ring: number, t: number, color: THREE.Color, flip: boolean) => {
    const base = pos.length / 3;
    const p = center(t);
    pos.push(p.x, p.y, p.z);
    col.push(color.r, color.g, color.b);
    for (let j = 0; j < SIDES; j++) {
      const k = (ring * SIDES + j) * 3;
      pos.push(pos[k], pos[k + 1], pos[k + 2]);
      col.push(color.r, color.g, color.b);
    }
    for (let j = 0; j < SIDES; j++) {
      const a = base + 1 + j;
      const b = base + 1 + ((j + 1) % SIDES);
      if (flip) idx.push(base, a, b);
      else idx.push(base, b, a);
    }
  };
  cap(0, 0, STEM_CUT, true);
  cap(SEGMENTS, 1, TIP, false);

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  g.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  g.computeBoundingBox();
  g.computeBoundingSphere();

  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }));
  m.castShadow = true;
  m.name = "banana";
  return m;
}
