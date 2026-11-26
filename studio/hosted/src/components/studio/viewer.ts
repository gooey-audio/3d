// three.js preview, set up to read like `gooey-3d render`: Z-up STLs turned Y-up,
// the same studio rig (key, fill and rim softboxes over a dim dome, placed relative to
// the camera), Khronos PBR Neutral tonemapping, exposure, and a shadow-catcher ground.
// It approximates the path tracer; procedural textures and wood figure are not shown.
// Ported from studio/web/src/viewer.ts. HDRI environments live on the render host's disk, so
// the hosted preview shows them (and rooms) with the studio rig.
//
// Picking: STLLoader gives non-indexed triangles in file order and nothing below reorders them
// (rotateX transforms in place; toCreasedNormals keeps a non-indexed geometry's order and only
// recomputes normals), so a raycast's `faceIndex` is the STL triangle number, which the face
// table (selection.ts `Face`) maps to a B-rep face. Highlights are overlay meshes sharing the
// part's attributes, drawn with one group per face's triangle range. A pointer that moved
// 4 px or more between down and up was an orbit drag, not a click.
//
// Coordinates: the part is Z up (mm: meshes are always mm, whatever the script's units); the
// labels, grid and dimensions are shown in the studio's units (`setUnits`). The viewer turned it Y up by -90 degrees about X, so
// viewer (x, y, z) = part (x, z, -y), and part = viewer (x, -z, y).

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Resolved } from "@/lib/scene";
import { makeBanana } from "./banana";
import { parseStl } from "./mesh";
import type { Face, FaceSelection } from "@/lib/selection";
import { DEFAULT_UNITS, fmtLength, niceStep, type Units } from "@/lib/units";
import type { PrintMarks } from "./printability";

export type Vec3 = [number, number, number];
/** A click on a face, in part coordinates (mm, Z up). `normal` is the clicked triangle's. */
export type Pick = { face: Face; point: Vec3; normal: Vec3 };
export type ViewerOptions = { edges: boolean; wireframe: boolean; grid: boolean; dims: boolean; banana: boolean };
export type ViewerEvents = {
  /** A click on a face (`pick`) or on empty space (`null`); `additive`: shift was held. */
  onPick?: (pick: Pick | null, additive: boolean) => void;
  /** The user started turning or panning the camera. */
  onOrbitStart?: () => void;
};

/** Viewer (Y up) to part (Z up) coordinates: the inverse of rotateX(-90 degrees). */
export const toPart = (v: THREE.Vector3): Vec3 => [v.x, -v.z, v.y];
export const fromPart = (p: number[], out = new THREE.Vector3()) => out.set(p[0], p[2], -p[1]);

const CLICK_SLOP_PX = 4;
const EDGE_ANGLE_DEG = 25;
const CAMERA_KEY = "gooey-studio.camera.";

// engine/crates/render/src/env.rs: RIG and STUDIO_DOME.
const RIG = [
  { az: -40, el: 42, size: 1.6, irradiance: 2.4, tint: [1.0, 0.97, 0.92] },
  { az: 65, el: 12, size: 2.2, irradiance: 0.55, tint: [0.92, 0.96, 1.0] },
  { az: 160, el: 50, size: 1.2, irradiance: 1.3, tint: [1.0, 1.0, 1.0] },
];
const DOME = { top: [0.2, 0.205, 0.215], horizon: [0.11, 0.11, 0.115], bottom: [0.03, 0.03, 0.03] };
const PADDING = 0.06;
const SHADOW_STRENGTH = 0.85;

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(25, 1, 0.1, 100000);
  private controls: OrbitControls;
  private material = new THREE.MeshPhysicalMaterial({ color: 0xc8c8c8, roughness: 0.75 });
  private mesh: THREE.Mesh | null = null;
  private ground: THREE.Mesh;
  private shadowLight = new THREE.DirectionalLight(0xffffff, 0);
  private studioEnv: THREE.Texture | null = null;
  private studio = studioScene();
  private pmrem: THREE.PMREMGenerator;
  private envAz = NaN;
  private envAt = 0;
  private envType = "studio";
  private rigRotation = 0;
  private radius = 50;
  private center = new THREE.Vector3();
  private observer: ResizeObserver;
  private frame = 0;
  private disposed = false;

  // Picking and highlights.
  events: ViewerEvents = {};
  private faces: Face[] = [];
  private faceByNumber = new Map<number, Face>();
  private triFace: Int32Array = new Int32Array(0); // triangle -> index into `faces`, -1: none
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private pointer: { x: number; y: number } | null = null;
  private down: { x: number; y: number } | null = null;
  private hoverDirty = false;
  private hovered: Face | null = null;
  private selection: FaceSelection[] = [];
  private hoverMat = overlayMaterial(0x7aa2f7, 0.38);
  private selMat = overlayMaterial(0xff9f43, 0.6);
  private hoverMesh: THREE.Mesh;
  private selMesh: THREE.Mesh;

  // Toggles.
  private options: ViewerOptions = { edges: false, wireframe: false, grid: false, dims: false, banana: false };
  private edges: THREE.LineSegments | null = null;
  private wire: THREE.Mesh;
  private grid: THREE.GridHelper | null = null;
  private box = new THREE.Box3();
  private boxHelper: THREE.Box3Helper;
  private banana: THREE.Mesh | null = null;
  /** What the camera frames, the ground and the shadows cover: the part, plus the banana. */
  private bounds = new THREE.Sphere(new THREE.Vector3(), 50);
  /** Grid spacing (mm) for the current part: a round number in `units`. */
  gridStep = 0;
  /** Face hover and picking (off while the preview frames renders). */
  private picking = true;
  /** The units labels, dimensions and the grid are in. */
  private units: Units = DEFAULT_UNITS;

  // Labels: HTML over the canvas, placed every frame.
  private labels: HTMLDivElement;
  private tip: HTMLDivElement;
  private pickLabel: HTMLDivElement;
  private pickAt: THREE.Vector3 | null = null;
  private dimLabels: HTMLDivElement[];

  // Print issues: overhang triangles (an overlay like the highlights), thin-section planes and
  // post lines (drawn through the part), with labels.
  private marks: PrintMarks | null = null;
  private overhangMesh: THREE.Mesh;
  private markGroup = new THREE.Group();
  private markLabels: { at: THREE.Vector3; el: HTMLDivElement }[] = [];

  // Camera persistence (per part, sessionStorage).
  private part: string | null = null;
  private lookSeen = false;
  private autoFramed = false;
  private saveTimer: number | undefined;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    (window as unknown as { studioViewer?: Viewer }).studioViewer = this; // for debugging and UI tests

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.updateStudio(0);

    // Shadows only: the light adds nothing (intensity 0), the catcher darkens where it is blocked.
    this.shadowLight.castShadow = true;
    this.shadowLight.shadow.mapSize.set(2048, 2048);
    this.shadowLight.shadow.radius = 6;
    this.shadowLight.shadow.bias = -0.0005;
    this.scene.add(this.shadowLight, this.shadowLight.target);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShadowMaterial({ opacity: SHADOW_STRENGTH * 0.45 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    // The part is pushed back a little in depth so overlays and lines on it win.
    Object.assign(this.material, { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.hoverMesh = new THREE.Mesh(new THREE.BufferGeometry(), [this.hoverMat]);
    this.selMesh = new THREE.Mesh(new THREE.BufferGeometry(), [this.selMat]);
    this.selMesh.renderOrder = 2;
    this.hoverMesh.renderOrder = 3;
    this.wire = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: 0x000000, wireframe: true, transparent: true, opacity: 0.12, depthWrite: false }),
    );
    this.wire.renderOrder = 1;
    this.overhangMesh = new THREE.Mesh(new THREE.BufferGeometry(), [
      overlayMaterial(0xf04848, 0.7),
      overlayMaterial(0xe6b450, 0.55),
    ]);
    this.overhangMesh.renderOrder = 2;
    this.markGroup.renderOrder = 4;
    this.scene.add(this.markGroup);
    this.boxHelper = new THREE.Box3Helper(this.box, 0x7aa2f7);
    Object.assign(this.boxHelper.material, { transparent: true, opacity: 0.75, depthWrite: false });
    for (const o of [this.hoverMesh, this.selMesh, this.overhangMesh, this.wire, this.boxHelper]) {
      o.visible = false;
      this.scene.add(o);
    }

    this.labels = el("div", "viewer-labels");
    this.tip = el("div", "viewer-tip");
    this.pickLabel = el("div", "viewer-pick");
    this.dimLabels = ["x", "y", "z"].map((a) => el("div", `viewer-dim dim-${a}`));
    this.labels.append(this.tip, this.pickLabel, ...this.dimLabels);
    container.appendChild(this.labels);
    this.hide(this.tip, this.pickLabel, ...this.dimLabels);

    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", (e) => {
      this.down = { x: e.clientX, y: e.clientY };
      this.setHover(null);
    });
    canvas.addEventListener("pointerup", (e) => {
      const d = this.down;
      this.down = null;
      this.hoverDirty = true;
      if (!d || !this.picking || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) >= CLICK_SLOP_PX) return;
      this.click(e.clientX, e.clientY, e.shiftKey);
    });
    canvas.addEventListener("pointermove", (e) => {
      this.pointer = { x: e.clientX, y: e.clientY };
      if (e.buttons) this.setHover(null);
      else this.hoverDirty = true;
    });
    canvas.addEventListener("pointerleave", () => {
      this.pointer = null;
      this.setHover(null);
    });
    this.controls.addEventListener("start", () => this.events.onOrbitStart?.());
    this.controls.addEventListener("change", () => {
      if (this.saveTimer === undefined) this.saveTimer = window.setTimeout(() => this.saveCamera(), 300);
    });
    window.addEventListener("pagehide", this.onPageHide);

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
    const loop = () => {
      if (this.disposed) return;
      this.frame = requestAnimationFrame(loop);
      this.controls.update();
      this.updateRig();
      if (this.hoverDirty && this.pointer && !this.down && this.picking) {
        this.hoverDirty = false;
        const hit = this.raycast(this.pointer.x, this.pointer.y);
        this.setHover(hit ? this.faceAt(hit.faceIndex) : null);
      }
      this.renderer.render(this.scene, this.camera);
      this.placeLabels();
    };
    loop();
  }

  dispose() {
    this.saveCamera();
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    window.removeEventListener("pagehide", this.onPageHide);
    this.labels.remove();
    this.observer.disconnect();
    this.controls.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
    // Release the context now (after dispose, which unhooks three's context-lost handler):
    // leaving for the parts screen and coming back mounts a new viewer.
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  /** Replaces the part; keeps the camera unless the part moved or changed size a lot. The
   *  face table must be set right after (`setFaces`): the old one does not fit the new mesh. */
  setMesh(stl: ArrayBuffer) {
    const geom = parseStl(stl);
    geom.computeBoundingSphere();
    geom.computeBoundingBox();
    const sphere = geom.boundingSphere!;
    const first = !this.mesh;
    const moved =
      first ||
      Math.abs(sphere.radius - this.radius) / this.radius > 0.35 ||
      sphere.center.distanceTo(this.center) > this.radius * 0.35;
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = geom;
    } else {
      this.mesh = new THREE.Mesh(geom, this.material);
      this.mesh.castShadow = true;
      this.scene.add(this.mesh);
    }
    this.hoverMesh.geometry.dispose();
    this.selMesh.geometry.dispose();
    this.hoverMesh.geometry = sharedView(geom);
    this.selMesh.geometry = sharedView(geom);
    this.overhangMesh.geometry.dispose();
    this.overhangMesh.geometry = sharedView(geom);
    this.wire.geometry = geom;
    this.setFacesTable([]);
    this.edges?.geometry.dispose();
    this.edges?.removeFromParent();
    this.edges = null;
    this.box.copy(geom.boundingBox!);
    this.radius = sphere.radius;
    this.center.copy(sphere.center);
    this.updateGrid();
    this.applyOptions();
    this.updateMarks();
    if (first) {
      if (!this.restoreCamera()) {
        this.frameView(this.lastDirection);
        this.autoFramed = !this.lookSeen;
      }
    } else if (moved) {
      this.frameView(this.lastDirection);
    }
  }

  /** Sets the face table of the current mesh. Returns false (and disables picking) when it
   *  does not cover the mesh's triangles exactly: it belongs to another build. */
  setFaces(faces: Face[]): boolean {
    const tris = this.mesh ? this.mesh.geometry.attributes.position.count / 3 : 0;
    let covered = 0;
    let ok = faces.length > 0;
    for (const f of faces) {
      if (!(f.start >= 0 && f.count >= 0 && f.start + f.count <= tris)) ok = false;
      covered += f.count;
    }
    ok &&= covered === tris;
    this.setFacesTable(ok ? faces : []);
    return ok;
  }

  private setFacesTable(faces: Face[]) {
    this.faces = faces;
    this.faceByNumber = new Map(faces.map((f) => [f.face, f]));
    const tris = this.mesh ? this.mesh.geometry.attributes.position.count / 3 : 0;
    this.triFace = new Int32Array(tris).fill(-1);
    faces.forEach((f, i) => this.triFace.fill(i, f.start, f.start + f.count));
    this.hovered = null;
    this.hoverMesh.visible = false;
    this.setSelection(this.selection);
  }

  /** Shows the selected faces (the page owns the selection) and a label at the last one. */
  setSelection(sel: FaceSelection[]) {
    this.selection = sel;
    const g = this.selMesh.geometry;
    g.clearGroups();
    for (const s of sel) {
      const f = this.faceByNumber.get(s.face);
      if (f) g.addGroup(f.start * 3, f.count * 3, 0);
    }
    this.selMesh.visible = g.groups.length > 0;
    const last = sel[sel.length - 1];
    if (!last || !this.faceByNumber.has(last.face)) {
      this.pickAt = null;
      this.hide(this.pickLabel);
      return;
    }
    this.pickAt = fromPart(last.point);
    const u = this.units;
    const r = (v: number[], d: number) => `(${v.map((x) => fmt(x, d)).join(", ")})`;
    const len = (v: number[]) => `(${v.map((x) => fmtLength(x, u)).join(", ")}) ${u}`;
    this.pickLabel.innerHTML = "";
    const lines = [
      [`face ${last.face}`, ` · ${last.type.toLowerCase()}${sel.length > 1 ? ` · ${sel.length} selected` : ""}`],
      ["at", ` ${len(last.point)}`],
      ["centre", ` ${len(last.center)}`],
      ["normal", ` ${r(last.normal, 3)}`],
    ];
    for (const [k, v] of lines) {
      const row = el("div");
      row.append(el("b", "", k), document.createTextNode(v));
      this.pickLabel.appendChild(row);
    }
  }

  /** Shows labels, dimensions and the grid in `u`. */
  setUnits(u: Units) {
    if (u === this.units) return;
    this.units = u;
    if (this.mesh) this.updateGrid();
    this.applyOptions();
    this.setSelection(this.selection);
    this.updateMarks();
  }

  setOptions(o: Partial<ViewerOptions>) {
    const banana = this.options.banana;
    Object.assign(this.options, o);
    this.applyOptions();
    // Showing or hiding the banana changes what there is to frame: refit, keeping the angle.
    if (this.mesh && this.options.banana !== banana) {
      const d = this.camera.position.clone().sub(this.controls.target);
      const last = this.lastDirection; // "reset view" keeps the look's direction
      if (d.lengthSq() > 0) this.frameView([d.x, d.y, d.z]);
      this.lastDirection = last;
    }
  }

  private applyOptions() {
    const o = this.options;
    const has = !!this.mesh;
    if (o.edges && has && !this.edges) {
      this.edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(this.mesh!.geometry, EDGE_ANGLE_DEG),
        new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.9 }),
      );
      this.edges.renderOrder = 1;
      this.scene.add(this.edges);
    }
    if (this.edges) this.edges.visible = o.edges && has;
    this.wire.visible = o.wireframe && has;
    if (this.grid) this.grid.visible = o.grid && has;
    this.boxHelper.visible = o.dims && has;
    if (!(o.dims && has)) this.hide(...this.dimLabels);
    if (o.banana && has && !this.banana) {
      this.banana = makeBanana();
      this.scene.add(this.banana);
    }
    if (this.banana) this.banana.visible = o.banana && has;
    this.updateBounds();
  }

  /** Lays the banana beside the part (on its left, along the depth) and sizes the framing
   *  sphere, ground, clipping planes and shadow camera to what is shown. */
  private updateBounds() {
    const b = this.bounds.set(this.center, this.radius);
    if (this.banana?.visible) {
      const bb = this.banana.geometry.boundingBox!;
      const size = this.box.getSize(new THREE.Vector3());
      const gap = Math.max(20, 0.15 * Math.max(size.x, size.z));
      // On the part's left (-X; the default view is from the front right, so it does not hide
      // the part), long axis along the depth, its belly toward the part.
      this.banana.rotation.y = -Math.PI / 2;
      const half = (bb.max.z - bb.min.z) / 2;
      this.banana.position.set(this.box.min.x - gap - half, this.box.min.y, this.box.getCenter(new THREE.Vector3()).z);
      this.banana.updateMatrixWorld();
      b.union(this.banana.geometry.boundingSphere!.clone().applyMatrix4(this.banana.matrixWorld));
    }
    const r = b.radius;
    this.ground.position.set(b.center.x, this.box.min.y - r * 0.001, b.center.z);
    this.ground.scale.setScalar(r * 40);
    this.camera.near = r / 100;
    this.camera.far = r * 200;
    this.camera.updateProjectionMatrix();
    const s = this.shadowLight.shadow.camera as THREE.OrthographicCamera;
    Object.assign(s, { left: -r * 2, right: r * 2, top: r * 2, bottom: -r * 2 });
    s.near = 0.01;
    s.far = r * 12;
    s.updateProjectionMatrix();
  }

  /** Shows where the print issues are (null: hides them). Kept across meshes. */
  setPrintMarks(m: PrintMarks | null) {
    this.marks = m;
    this.updateMarks();
  }

  private updateMarks() {
    for (const o of this.markGroup.children) {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    }
    this.markGroup.clear();
    for (const l of this.markLabels) l.el.remove();
    this.markLabels = [];
    this.overhangMesh.visible = false;
    const m = this.marks;
    const mesh = this.mesh;
    if (!m || !mesh) return;
    const b = this.box;
    const label = (at: THREE.Vector3, text: string) => {
      const e = el("div", "viewer-issue", text);
      this.labels.appendChild(e);
      this.markLabels.push({ at, el: e });
    };

    if (m.overhangs) {
      // check.rs: triangles facing down more than 44.5 degrees past vertical, above the first
      // 0.3 mm. Flat ceilings (amber) may be bridges, which the check does not count.
      const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
      const g = this.overhangMesh.geometry;
      g.clearGroups();
      const cosT = Math.cos(((45 - 0.5) * Math.PI) / 180);
      const a = new THREE.Vector3();
      const u = new THREE.Vector3();
      const v = new THREE.Vector3();
      const n = pos.count / 3;
      let runMat = -1;
      let runStart = 0;
      for (let t = 0; t <= n; t++) {
        let mat = -1;
        if (t < n) {
          a.fromBufferAttribute(pos, 3 * t);
          u.fromBufferAttribute(pos, 3 * t + 1).sub(a);
          v.fromBufferAttribute(pos, 3 * t + 2).sub(a);
          const cy = a.y + (u.y + v.y) / 3;
          u.cross(v);
          const len = u.length();
          const ny = len > 0 ? u.y / len : 0;
          if (ny < -cosT && cy > b.min.y + 0.3) mat = ny < -0.999 ? 1 : 0;
        }
        if (mat !== runMat) {
          if (runMat >= 0) g.addGroup(runStart * 3, (t - runStart) * 3, runMat);
          runMat = mat;
          runStart = t;
        }
      }
      this.overhangMesh.visible = g.groups.length > 0;
    }

    // Planes and lines draw over the part: the problem is usually inside or behind it.
    const size = b.getSize(new THREE.Vector3());
    const ctr = b.getCenter(new THREE.Vector3());
    const pad = Math.max(size.x, size.z) * 0.08 + 2;
    const onTop = { depthTest: false, depthWrite: false, transparent: true, toneMapped: false };
    const u = this.units;
    for (const [z0, z1] of m.thin) {
      // A band over the footprint from half a layer below the first thin section to half
      // above the last, outlined top and bottom.
      const lo = z0 - 0.25;
      const hi = z1 + 0.25;
      const w = size.x + 2 * pad;
      const d = size.z + 2 * pad;
      const band = new THREE.Mesh(
        new THREE.BoxGeometry(w, hi - lo, d),
        new THREE.MeshBasicMaterial({ color: 0xf04848, opacity: 0.08, side: THREE.DoubleSide, ...onTop }),
      );
      band.position.set(ctr.x, (lo + hi) / 2, ctr.z);
      const rim = new THREE.LineSegments(
        new THREE.EdgesGeometry(band.geometry),
        new THREE.LineBasicMaterial({ color: 0xf04848, opacity: 0.9, ...onTop }),
      );
      rim.position.copy(band.position);
      this.markGroup.add(band, rim);
      const z = z0 === z1 ? fmtLength(z0, u) : `${fmtLength(z0, u)}–${fmtLength(z1, u)}`;
      label(new THREE.Vector3(ctr.x + w / 2, hi, ctr.z + d / 2), `thin at z ${z} ${u}`);
    }
    for (const p of m.posts) {
      const at = fromPart([p.at[0], p.at[1], 0]);
      const top = new THREE.Vector3(at.x, b.max.y + pad, at.z);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(at.x, b.min.y, at.z), top]),
        new THREE.LineBasicMaterial({ color: 0xf04848, ...onTop }),
      );
      this.markGroup.add(line);
      label(top, `post ${fmtLength(p.height, u)} × ${fmtLength(p.width, u)} ${u}`);
    }
  }

  /** A grid on the ground, about ten cells across the part's footprint (1/2/5 x 10^n of the
   *  unit, or 1/16 .. 1/2 in). */
  private updateGrid() {
    this.grid?.geometry.dispose();
    this.grid?.removeFromParent();
    const size = this.box.getSize(new THREE.Vector3());
    const foot = Math.max(size.x, size.z, 1e-3);
    const step = niceStep(foot / 10, this.units);
    const extent = Math.ceil((foot * 1.6) / step / 2) * 2 * step;
    this.grid = new THREE.GridHelper(extent, Math.round(extent / step), 0x6b7385, 0x3c414b);
    Object.assign(this.grid.material, { transparent: true, opacity: 0.6, depthWrite: false });
    const c = this.box.getCenter(new THREE.Vector3());
    this.grid.position.set(c.x, this.box.min.y - this.radius * 0.0005, c.z);
    this.gridStep = step;
    this.scene.add(this.grid);
  }

  /** Where a point in part coordinates is on the page (client px), or null if behind. */
  projectPart(p: number[]): { x: number; y: number } | null {
    const v = fromPart(p).project(this.camera);
    if (v.z > 1) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }

  private raycast(clientX: number, clientY: number) {
    if (!this.mesh) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return this.raycaster.intersectObject(this.mesh, false)[0] ?? null;
  }

  private faceAt(triangle: number | null | undefined): Face | null {
    if (triangle == null) return null;
    const i = this.triFace[triangle];
    return i === undefined || i < 0 ? null : this.faces[i];
  }

  private click(x: number, y: number, additive: boolean) {
    const hit = this.raycast(x, y);
    if (!hit) {
      this.events.onPick?.(null, additive);
      return;
    }
    const face = this.faceAt(hit.faceIndex);
    if (!face || !hit.face) return; // no face table for this mesh
    // The mesh has no transform: the hit and its triangle normal are in viewer coordinates.
    this.events.onPick?.({ face, point: toPart(hit.point), normal: toPart(hit.face.normal) }, additive);
  }

  private setHover(face: Face | null) {
    const canvas = this.renderer.domElement;
    if (face !== this.hovered) {
      this.hovered = face;
      const g = this.hoverMesh.geometry;
      g.clearGroups();
      if (face) g.addGroup(face.start * 3, face.count * 3, 0);
      this.hoverMesh.visible = !!face;
      canvas.style.cursor = face ? "pointer" : "";
      if (face) this.tip.textContent = `face ${face.face} · ${face.type.toLowerCase()}`;
    }
    if (face && this.pointer) {
      const r = this.container.getBoundingClientRect();
      this.show(this.tip, this.pointer.x - r.left + 14, this.pointer.y - r.top + 12);
    } else {
      this.hide(this.tip);
    }
  }

  /** Places the pick label and the dimension labels (every frame). */
  private placeLabels() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const at = (v: THREE.Vector3, label: HTMLElement) => {
      const p = v.clone().project(this.camera);
      if (p.z > 1 || Math.abs(p.x) > 1.2 || Math.abs(p.y) > 1.2) return this.hide(label);
      this.show(label, ((p.x + 1) / 2) * w, ((1 - p.y) / 2) * h);
    };
    if (this.pickAt) at(this.pickAt, this.pickLabel);
    for (const l of this.markLabels) at(l.at, l.el);
    if (this.options.dims && this.mesh) {
      // Label the box edges facing the camera: X along the front, part Y along the side, Z up a
      // silhouette corner. Part X = viewer x, part Y = -viewer z, part Z = viewer y.
      const b = this.box;
      const cam = this.camera.position;
      const c = b.getCenter(new THREE.Vector3());
      const zs = cam.z >= c.z ? b.max.z : b.min.z;
      const xs = cam.x >= c.x ? b.max.x : b.min.x;
      const xo = cam.x >= c.x ? b.min.x : b.max.x;
      const y0 = cam.y >= b.min.y ? b.min.y : b.max.y;
      const size = b.getSize(new THREE.Vector3());
      const spots: [THREE.Vector3, string][] = [
        [new THREE.Vector3(c.x, y0, zs), `X ${fmtLength(size.x, this.units)} ${this.units}`],
        [new THREE.Vector3(xs, y0, c.z), `Y ${fmtLength(size.z, this.units)} ${this.units}`],
        [new THREE.Vector3(xo, c.y, zs), `Z ${fmtLength(size.y, this.units)} ${this.units}`],
      ];
      spots.forEach(([v, text], i) => {
        if (this.dimLabels[i].textContent !== text) this.dimLabels[i].textContent = text;
        at(v, this.dimLabels[i]);
      });
    }
  }

  private show(e: HTMLElement, x: number, y: number) {
    e.style.display = "";
    e.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  private hide(...es: HTMLElement[]) {
    for (const e of es) e.style.display = "none";
  }

  // --- camera persistence -------------------------------------------------------------

  private onPageHide = () => this.saveCamera();

  private saveCamera() {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.part || !this.mesh) return;
    try {
      const v = { p: this.camera.position.toArray(), t: this.controls.target.toArray(), r: this.radius };
      sessionStorage.setItem(CAMERA_KEY + this.part, JSON.stringify(v));
    } catch {
      /* storage full or unavailable */
    }
  }

  /** The part's saved camera, if it still fits the part (it may have changed a lot). */
  private restoreCamera(): boolean {
    if (!this.part) return false;
    let v: { p: number[]; t: number[]; r: number } | null = null;
    try {
      v = JSON.parse(sessionStorage.getItem(CAMERA_KEY + this.part) ?? "null");
    } catch {
      return false;
    }
    if (!v || v.p?.length !== 3 || v.t?.length !== 3 || !(v.r > 0)) return false;
    const t = new THREE.Vector3().fromArray(v.t);
    const p = new THREE.Vector3().fromArray(v.p);
    const dist = p.distanceTo(t);
    if (Math.abs(v.r - this.radius) / this.radius > 0.35 || t.distanceTo(this.center) > this.radius * 2) return false;
    if (!(dist > this.radius * 0.05 && dist < this.radius * 100)) return false;
    this.controls.target.copy(t);
    this.camera.position.copy(p);
    this.camera.lookAt(t);
    this.controls.update();
    return true;
  }

  /** Removes the part (switching parts to `part`); the next mesh gets `part`'s saved camera,
   *  or frames the view afresh. */
  clear(part: string | null = null) {
    if (part !== this.part) {
      this.saveCamera();
      this.part = part;
    }
    this.lookSeen = false;
    this.autoFramed = false;
    this.selection = [];
    this.setHover(null);
    if (!this.mesh) return;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh = null;
    this.setFacesTable([]);
    this.applyOptions();
    this.updateMarks();
  }

  private lastDirection: [number, number, number] = [1.25, 0.8, 1.5];

  /** Points the camera along `direction` (part toward camera, Y up) and fits the part (and
   *  the banana, when shown). */
  frameView(direction: [number, number, number]) {
    this.lastDirection = direction;
    const dir = new THREE.Vector3(...direction).normalize();
    // Fit the bounding sphere in the narrower of the vertical and horizontal fields of view.
    const half = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const narrow = Math.min(half, Math.atan(Math.tan(half) * this.camera.aspect));
    const { center, radius } = this.bounds;
    const dist = (radius / Math.sin(narrow)) * (1 + PADDING);
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.lookAt(center);
    this.controls.update();
  }

  /** Applies the resolved scene. `reframe`: the camera view changed. */
  setLook(r: Resolved, reframe: boolean) {
    const m = r.material;
    const mat = this.material;
    mat.color.setRGB(m.color[0], m.color[1], m.color[2], THREE.LinearSRGBColorSpace);
    mat.roughness = m.roughness;
    mat.metalness = m.metalness;
    mat.clearcoat = m.clearcoat;
    mat.clearcoatRoughness = m.clearcoat_roughness;
    mat.transmission = m.transmission;
    mat.thickness = 0;
    mat.ior = m.ior;
    mat.opacity = m.opacity;
    mat.transparent = m.opacity < 1 || m.transmission > 0;
    mat.sheen = m.sheen;
    mat.sheenColor.setRGB(1, 1, 1);
    mat.sheenRoughness = 0.5;
    mat.needsUpdate = true;

    this.renderer.toneMappingExposure = r.exposure;
    if (r.background === "transparent") {
      this.renderer.setClearColor(0x000000, 0);
    } else {
      this.renderer.setClearColor(new THREE.Color(r.background), 1);
    }
    this.envType = "studio";
    this.rigRotation = THREE.MathUtils.degToRad(r.environment.rotation_deg ?? 0);
    this.scene.environmentIntensity = r.environment.intensity ?? 1;
    this.envAz = NaN; // rebuild the studio for the current view
    const fovChanged = this.camera.fov !== r.camera.fov;
    if (fovChanged) {
      this.camera.fov = r.camera.fov;
      this.camera.updateProjectionMatrix();
    }
    this.lastDirection = r.camera.direction;
    if (!this.lookSeen) {
      // The first look of a part keeps a restored camera; it reframes only a mesh that was
      // framed (with the default direction) before the look arrived.
      this.lookSeen = true;
      reframe = !!this.mesh && this.autoFramed;
    } else if (fovChanged) {
      reframe = true;
    }
    if (reframe) this.frameView(r.camera.direction);
  }

  /** The studio rig follows the camera's azimuth, as in the path tracer. */
  private updateRig() {
    const view = this.camera.position.clone().sub(this.controls.target);
    const studio = this.envType !== "hdri";
    const az = (studio ? Math.atan2(view.x, view.z) : 0) + this.rigRotation;
    if (studio) {
      this.updateStudio(az);
    } else {
      this.scene.environmentRotation.set(0, this.rigRotation, 0);
    }
    const key = RIG[0];
    const kaz = az + THREE.MathUtils.degToRad(key.az);
    const kel = THREE.MathUtils.degToRad(key.el);
    const d = new THREE.Vector3(Math.cos(kel) * Math.sin(kaz), Math.sin(kel), Math.cos(kel) * Math.cos(kaz));
    this.shadowLight.position.copy(this.bounds.center).addScaledVector(d, this.bounds.radius * 6);
    this.shadowLight.target.position.copy(this.bounds.center);
  }

  /** Re-renders the studio environment with the rig turned to `az` (radians), at most
   *  every 60 ms and only when the view turned more than 2 degrees. */
  private updateStudio(az: number) {
    const diff = Math.abs(Math.atan2(Math.sin(az - this.envAz), Math.cos(az - this.envAz)));
    const now = performance.now();
    if (!(Number.isNaN(this.envAz) || (diff > 0.035 && now - this.envAt > 60))) return;
    this.envAz = az;
    this.envAt = now;
    this.studio.rotation.y = az;
    this.studio.updateMatrixWorld(true);
    const old = this.studioEnv;
    this.studioEnv = this.pmrem.fromScene(this.studio, 0, 0.1, 1000).texture;
    this.scene.environment = this.studioEnv;
    this.scene.environmentRotation.set(0, 0, 0);
    old?.dispose();
  }

  setPicking(on: boolean) {
    this.picking = on;
    if (!on) this.setHover(null);
  }

  /** The camera's direction (part toward camera, Y up): a render `view`. */
  cameraDirection(): Vec3 {
    const d = this.camera.position.clone().sub(this.controls.target).normalize();
    const r = (x: number) => Math.round(x * 1000) / 1000;
    return [r(d.x), r(d.y), r(d.z)];
  }

  resetView() {
    this.frameView(this.lastDirection);
  }

  snapshot(): string {
    return this.renderer.domElement.toDataURL("image/png");
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

function overlayMaterial(color: number, opacity: number) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
    toneMapped: false,
  });
}

/** A geometry drawing (groups of) another one's triangles: it shares the attributes. */
function sharedView(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const v = new THREE.BufferGeometry();
  v.setAttribute("position", g.getAttribute("position"));
  v.setAttribute("normal", g.getAttribute("normal"));
  v.boundingSphere = g.boundingSphere;
  v.boundingBox = g.boundingBox;
  return v;
}

const fmt = (x: number, d: number) => (Math.abs(x) < 0.5 * 10 ** -d ? 0 : x).toFixed(d);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** The studio as an environment: a gradient dome and three emissive softboxes, laid out
 *  for a camera on +Z (the viewer turns it with the camera). Radiance as in env.rs. */
function studioScene(): THREE.Scene {
  const s = new THREE.Scene();
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(100, 64, 32),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        top: { value: new THREE.Vector3(...DOME.top) },
        horizon: { value: new THREE.Vector3(...DOME.horizon) },
        bottom: { value: new THREE.Vector3(...DOME.bottom) },
      },
      vertexShader: `varying vec3 vDir; void main() { vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; varying vec3 vDir;
        void main() { float y = vDir.y;
          vec3 c = y > 0.0 ? mix(horizon, top, y) : mix(horizon, bottom, min(1.0, -y * 4.0));
          gl_FragColor = vec4(c, 1.0); }`,
    }),
  );
  s.add(dome);
  for (const b of RIG) {
    const az = THREE.MathUtils.degToRad(b.az);
    const el = THREE.MathUtils.degToRad(b.el);
    const dir = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
    const dist = 4;
    const size = b.size;
    const radiance = (b.irradiance * dist * dist) / (size * size);
    const m = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    m.color.setRGB(b.tint[0] * radiance, b.tint[1] * radiance, b.tint[2] * radiance, THREE.LinearSRGBColorSpace);
    const box = new THREE.Mesh(new THREE.PlaneGeometry(size, size), m);
    box.position.copy(dir.multiplyScalar(dist));
    box.lookAt(0, 0, 0);
    s.add(box);
  }
  return s;
}

