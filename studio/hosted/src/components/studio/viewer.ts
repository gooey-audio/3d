// three.js preview, set up to read like `gooey-3d render`: Z-up STLs turned Y-up,
// the same studio rig (key, fill and rim softboxes over a dim dome, placed relative to
// the camera), Khronos PBR Neutral tonemapping, exposure, and a shadow-catcher ground.
// It approximates the path tracer; procedural textures and wood figure are not shown.
// Ported from studio/web/src/viewer.ts. HDRI environments live on the render host's disk, so
// the hosted preview shows them (and rooms) with the studio rig.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import type { Resolved } from "@/lib/scene";

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

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
    const loop = () => {
      if (this.disposed) return;
      this.frame = requestAnimationFrame(loop);
      this.controls.update();
      this.updateRig();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.controls.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /** Replaces the part; keeps the camera unless the part moved or changed size a lot. */
  setMesh(stl: ArrayBuffer) {
    let geom = new STLLoader().parse(stl);
    geom.rotateX(-Math.PI / 2); // Z up -> Y up, as `--up z`
    geom = toCreasedNormals(geom, (30 * Math.PI) / 180);
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
    this.radius = sphere.radius;
    this.center.copy(sphere.center);
    const minY = geom.boundingBox!.min.y;
    this.ground.position.set(sphere.center.x, minY - this.radius * 0.001, sphere.center.z);
    this.ground.scale.setScalar(this.radius * 40);
    this.camera.near = this.radius / 100;
    this.camera.far = this.radius * 200;
    this.camera.updateProjectionMatrix();
    const s = this.shadowLight.shadow.camera as THREE.OrthographicCamera;
    Object.assign(s, { left: -this.radius * 2, right: this.radius * 2, top: this.radius * 2, bottom: -this.radius * 2 });
    s.near = 0.01;
    s.far = this.radius * 12;
    s.updateProjectionMatrix();
    if (moved) this.frameView(this.lastDirection);
  }

  /** Removes the part (switching parts); the next mesh frames the view afresh. */
  clear() {
    if (!this.mesh) return;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh = null;
  }

  private lastDirection: [number, number, number] = [1.25, 0.8, 1.5];

  /** Points the camera along `direction` (part toward camera, Y up) and fits the part. */
  frameView(direction: [number, number, number]) {
    this.lastDirection = direction;
    const dir = new THREE.Vector3(...direction).normalize();
    // Fit the bounding sphere in the narrower of the vertical and horizontal fields of view.
    const half = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const narrow = Math.min(half, Math.atan(Math.tan(half) * this.camera.aspect));
    const dist = (this.radius / Math.sin(narrow)) * (1 + PADDING);
    this.controls.target.copy(this.center);
    this.camera.position.copy(this.center).addScaledVector(dir, dist);
    this.camera.lookAt(this.center);
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
    if (this.camera.fov !== r.camera.fov) {
      this.camera.fov = r.camera.fov;
      this.camera.updateProjectionMatrix();
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
    this.shadowLight.position.copy(this.center).addScaledVector(d, this.radius * 6);
    this.shadowLight.target.position.copy(this.center);
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

