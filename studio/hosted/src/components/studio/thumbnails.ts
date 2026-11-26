// Part thumbnails for the parts screen. Browsers cap live WebGL contexts (about 16) and drop
// the oldest past that, so every card shares one offscreen renderer: each mesh is drawn once
// and kept as a PNG data URL, cached per part and mesh version for the page's lifetime.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { api } from "./api";
import { parseStl } from "./mesh";

/** `size`: the part's bounding box in mm, in part coordinates (x, y, z; Z up). */
export type Thumb = { url: string; size: [number, number, number] };

const WIDTH = 480;
const HEIGHT = 360;
const FOV = 25;
const PARALLEL = 3; // mesh downloads at once
// A three-quarter view from the front right and above (viewer coordinates: Y up, front +Z).
const VIEW = new THREE.Vector3(0.62, 0.48, 0.82).normalize();

type Ctx = { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; material: THREE.Material };
let ctx: Ctx | null | undefined; // null: no WebGL here

function context(): Ctx | null {
  if (ctx !== undefined) return ctx;
  try {
    const canvas = document.createElement("canvas");
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(WIDTH, HEIGHT, false);
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    scene.environment = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    scene.environmentIntensity = 0.6;
    const camera = new THREE.PerspectiveCamera(FOV, WIDTH / HEIGHT, 0.1, 1000);
    // A key light that follows the camera (up and to the left of it), so every part reads alike.
    // Its target rides along too: left in the scene's origin, the light's direction would depend
    // on where the part sits rather than on the view.
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-1, 1.5, 1);
    key.target.position.set(0, 0, -1);
    camera.add(key, key.target);
    scene.add(camera);
    const material = new THREE.MeshStandardMaterial({ color: 0xc8c8c8, roughness: 0.6, metalness: 0 });
    // A lost context (GPU reset, too many contexts) is rebuilt on the next thumbnail.
    canvas.addEventListener("webglcontextlost", () => {
      if (ctx?.renderer === renderer) ctx = undefined;
    });
    ctx = { renderer, scene, camera, material };
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Draws the STL and returns it as an image, or null if it has no triangles or no WebGL. */
function draw(stl: ArrayBuffer): Thumb | null {
  const c = context();
  if (!c) return null;
  const geom = parseStl(stl);
  try {
    if (!geom.getAttribute("position")?.count) return null;
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
    const box = geom.boundingBox!;
    const { center, radius } = geom.boundingSphere!;
    if (!(radius > 0)) return null;
    const mesh = new THREE.Mesh(geom, c.material);
    c.scene.add(mesh);
    try {
      // Fit the bounding sphere in the narrower (vertical) field of view, with a little margin.
      const dist = (radius / Math.sin(THREE.MathUtils.degToRad(FOV / 2))) * 1.04;
      c.camera.position.copy(center).addScaledVector(VIEW, dist);
      c.camera.near = dist / 100;
      c.camera.far = dist * 4;
      c.camera.lookAt(center);
      c.camera.updateProjectionMatrix();
      c.renderer.render(c.scene, c.camera);
      const url = c.renderer.domElement.toDataURL("image/png");
      const s = box.getSize(new THREE.Vector3());
      return { url, size: [s.x, s.z, s.y] }; // viewer (x, y, z) = part (x, z, -y)
    } finally {
      c.scene.remove(mesh);
    }
  } finally {
    geom.dispose();
  }
}

// Downloads wait for a slot so a long list does not fetch every mesh at once.
let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (active < PARALLEL) active++;
  else await new Promise<void>((r) => waiting.push(r)); // a finishing download hands over its slot
  try {
    return await run();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

const done = new Map<string, Thumb | null>();
const pending = new Map<string, Promise<Thumb | null>>();
const cacheKey = (part: string, version: number) => `${part}@${version}`;

/** A finished thumbnail, if there is one (null: nothing to show), without waiting. */
export function cachedThumbnail(part: string, version: number): Thumb | null | undefined {
  return done.get(cacheKey(part, version));
}

/** The part's mesh (`version`: when it was written) as a thumbnail; null when there is no mesh
 *  or nothing to draw. Rejects on download errors, which are not cached (a later call retries). */
export function thumbnail(part: string, version: number): Promise<Thumb | null> {
  const k = cacheKey(part, version);
  if (done.has(k)) return Promise.resolve(done.get(k)!);
  let p = pending.get(k);
  if (!p) {
    p = slot(async () => {
      const res = await fetch(api.meshUrl(part, version), { cache: "no-store" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`mesh: ${res.status}`);
      return draw(await res.arrayBuffer());
    }).then(
      (t) => {
        done.set(k, t);
        pending.delete(k);
        return t;
      },
      (e) => {
        pending.delete(k);
        throw e;
      },
    );
    pending.set(k, p);
  }
  return p;
}
