import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { effectiveSet, projectDuration, type Bundle, type Shot } from '@shortstudio/schema';
import { applyLighting, type LightRig } from './lighting';
import { Mannequin } from './mannequin';
import { actorPoseAt } from './pose';
import { buildProp, type PropMesh } from './propMeshes';
import { propStateAt } from './propState';
import { resolveAt } from './resolve';
import { cameraCreepScale } from './rules';
import { CaptionOverlay } from './captionOverlay';
import { buildCaptionLines, captionAt, type CaptionLine } from './captions';
import { repairSceneNormals } from './normals';
import { PostChain } from './post';
import { buildSetObject } from './setbuilder';
import { updateWhiteLift } from './shaders';

export interface Pick {
  kind: 'actor' | 'prop' | 'set';
  id: string;
}

export interface PickResult extends Pick {
  shotId: string;
  point: [number, number, number];
  distance: number;
}

class ShotScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private rig: LightRig;
  private actors: Mannequin[] = [];
  private props: { def: Shot['props'][number]; mesh: PropMesh }[] = [];
  private toon: THREE.ShaderMaterial[] = [];

  readonly post: PostChain | undefined;
  private focus = 10;
  private selection: { ref: Pick; lines: LineSegments2; material: LineMaterial } | undefined;

  constructor(private shot: Shot, bundle: Bundle, renderer: THREE.WebGLRenderer, width: number, height: number) {
    const aspect = width / height;
    const set = effectiveSet(bundle.sets[shot.set]!, shot);
    this.scene.background = new THREE.Color(set.background);
    if (set.fog) this.scene.fog = new THREE.Fog(set.fog.color, set.fog.near, set.fog.far);
    this.rig = applyLighting(this.scene, set.lighting);
    for (const o of set.objects) this.scene.add(buildSetObject(o));
    for (const a of shot.actors) {
      const m = new Mannequin(a);
      this.actors.push(m);
      this.toon.push(...m.toonMaterials);
      this.scene.add(m.group);
    }
    for (const def of shot.props) {
      const mesh = buildProp(def);
      this.props.push({ def, mesh });
      this.toon.push(...mesh.toonMaterials);
      this.scene.add(mesh.group);
    }
    repairSceneNormals(this.scene);
    this.camera = new THREE.PerspectiveCamera(shot.camera.fov, aspect, 0.1, 200);
    const look = bundle.project.look;
    if (look.bloom || look.dof) this.post = new PostChain(renderer, this.scene, this.camera, width, height, look);
  }

  /** The clickable thing (actor, prop or set object) with this id, or undefined. */
  private target(ref: Pick): THREE.Object3D | undefined {
    return this.scene.children.find((o) => o.userData.pick?.kind === ref.kind && o.userData.pick?.id === ref.id);
  }

  /** Raycast from the camera through NDC (x, y); the nearest clickable thing, if any. */
  pick(x: number, y: number): { ref: Pick; point: THREE.Vector3; distance: number } | null {
    this.scene.updateMatrixWorld(true); // three only does this while rendering; a click can arrive before any frame
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(x, y), this.camera);
    for (const hit of ray.intersectObjects(this.scene.children, true)) {
      for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
        const p = o.userData.pick as Pick | undefined;
        if (p) return { ref: { kind: p.kind, id: p.id }, point: hit.point, distance: hit.distance };
      }
    }
    return null;
  }

  /** A glowing box around the selected object (editor only; never drawn by an export). */
  setSelection(ref: Pick | null, size: { width: number; height: number }): void {
    if (this.selection) {
      this.scene.remove(this.selection.lines);
      this.selection.lines.geometry.dispose();
      this.selection.material.dispose();
      this.selection = undefined;
    }
    if (!ref) return;
    const material = new LineMaterial({ linewidth: 3, color: 0xffffff, toneMapped: false, depthTest: false, transparent: true });
    material.color.setRGB(0.1, 1.5, 1.9); // just brighter than white, so bloom gives it a soft glow without swamping the shot
    material.resolution.set(size.width, size.height);
    const lines = new LineSegments2(new LineSegmentsGeometry(), material);
    lines.renderOrder = 999;
    lines.raycast = () => {};
    this.scene.add(lines);
    this.selection = { ref, lines, material };
    this.updateSelection();
  }

  private updateSelection(): void {
    const sel = this.selection;
    if (!sel) return;
    const obj = this.target(sel.ref);
    if (!obj) return void (sel.lines.visible = false);
    const box = new THREE.Box3().setFromObject(obj).expandByScalar(0.06);
    const { min: a, max: b } = box;
    const c = [[a.x, a.y, a.z], [b.x, a.y, a.z], [b.x, a.y, b.z], [a.x, a.y, b.z], [a.x, b.y, a.z], [b.x, b.y, a.z], [b.x, b.y, b.z], [a.x, b.y, b.z]];
    const edges: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    sel.lines.geometry.setPositions(edges.flatMap(([i, j]) => [...c[i]!, ...c[j]!]));
    sel.lines.visible = true;
  }

  dispose(): void {
    this.setSelection(null, { width: 1, height: 1 });
    this.post?.dispose();
  }

  /** Distance from the camera to the actors (the point to keep sharp). */
  get focusDistance(): number {
    return this.focus;
  }

  /** Pose everything for `localT` seconds into the shot. Pure function of (shot, t). */
  apply(localT: number): void {
    const { position, target, creep } = this.shot.camera;
    const k = 1 / cameraCreepScale(localT, creep); // dolly in: apparent scale = 1 + creep * dt
    this.camera.position.set(
      target[0] + (position[0] - target[0]) * k,
      target[1] + (position[1] - target[1]) * k,
      target[2] + (position[2] - target[2]) * k,
    );
    this.camera.lookAt(...target);
    this.camera.updateMatrixWorld(true);
    let cx = 0, cz = 0;
    for (const m of this.actors) {
      const pose = actorPoseAt(this.shot, m.actor.id, this.shot.start + localT);
      m.applyPose(pose);
      cx += pose.rig.root[0];
      cz += pose.rig.root[2];
    }
    const n = this.actors.length || 1;
    const aim = this.actors.length ? new THREE.Vector3(cx / n, 1.2, cz / n) : new THREE.Vector3(...this.shot.camera.target); // 1.2 ~ torso height
    this.focus = this.camera.position.distanceTo(aim);
    for (const { def, mesh } of this.props) mesh.apply(propStateAt(this.shot, def, this.shot.start + localT));
    for (const mat of this.toon) updateWhiteLift(mat, this.rig, this.camera);
    this.updateSelection();
  }
}

const QUAD_VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const QUAD_FRAG = /* glsl */ `
  uniform sampler2D uA, uB; uniform float uMix; varying vec2 vUv;
  void main(){ gl_FragColor = mix(texture2D(uA, vUv), texture2D(uB, vUv), uMix);
  #include <colorspace_fragment>
  }`;

export class Studio {
  readonly renderer: THREE.WebGLRenderer;
  private bundle?: Bundle;
  private scenes = new Map<string, ShotScene>();
  private rtA: THREE.WebGLRenderTarget;
  private rtB: THREE.WebGLRenderTarget;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quadMat: THREE.ShaderMaterial;
  private captions: CaptionOverlay | undefined;
  private captionLines: CaptionLine[] = [];

  constructor(readonly canvas: HTMLCanvasElement, readonly width: number, readonly height: number) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    const rt = () => new THREE.WebGLRenderTarget(width, height, { samples: 4 });
    this.rtA = rt();
    this.rtB = rt();
    this.quadMat = new THREE.ShaderMaterial({
      uniforms: { uA: { value: null }, uB: { value: null }, uMix: { value: 0 } },
      vertexShader: QUAD_VERT,
      fragmentShader: QUAD_FRAG,
      depthTest: false,
    });
    this.quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.quadMat));
  }

  load(bundle: Bundle): void {
    for (const s of this.scenes.values()) s.dispose();
    this.scenes.clear();
    this.bundle = bundle;
    this.setupCaptions(bundle);
  }

  /**
   * Hot reload: swap in an updated bundle and rebuild only the named shots' scenes (all of them when none are
   * named). Every other shot keeps its scene, so a one-shot edit costs one scene build.
   */
  updateBundle(bundle: Bundle, changed?: string[]): void {
    this.bundle = bundle;
    for (const id of changed ?? [...this.scenes.keys()]) {
      this.scenes.get(id)?.dispose();
      this.scenes.delete(id);
    }
    if (this.selected && !bundle.shots[this.selected.shotId]) this.selected = undefined;
    this.setupCaptions(bundle);
  }

  private selected: (Pick & { shotId: string }) | undefined;

  /** What is under NDC point (x, y) (-1..1, y up) at timeline time `t`: the topmost shot's nearest clickable thing. */
  pick(t: number, x: number, y: number): PickResult | null {
    const layers = resolveAt(this.bundle!, t);
    const top = layers[layers.length - 1];
    if (!top) return null;
    const scene = this.sceneFor(top.shotId);
    scene.apply(top.localT);
    const hit = scene.pick(x, y);
    return hit ? { ...hit.ref, shotId: top.shotId, point: hit.point.toArray() as [number, number, number], distance: hit.distance } : null;
  }

  /** Draw (or clear, with null) the glowing selection box. Editor only: an export never calls this. */
  highlight(ref: (Pick & { shotId: string }) | null): void {
    if (this.selected) this.scenes.get(this.selected.shotId)?.setSelection(null, this);
    this.selected = ref ?? undefined;
    if (ref) this.sceneFor(ref.shotId).setSelection(ref, this);
  }

  private setupCaptions(bundle: Bundle): void {
    const c = bundle.project.captions;
    if (bundle.alignment && c.enabled) {
      this.captionLines = buildCaptionLines(bundle.alignment, { maxWords: c.maxWords });
      this.captions = new CaptionOverlay(this.width, this.height, c.highlight);
    } else {
      this.captionLines = [];
      this.captions = undefined;
    }
  }

  get duration(): number {
    return this.bundle ? projectDuration(this.bundle) : 0;
  }

  private sceneFor(id: string): ShotScene {
    let s = this.scenes.get(id);
    if (!s) {
      s = new ShotScene(this.bundle!.shots[id]!, this.bundle!, this.renderer, this.width, this.height);
      this.scenes.set(id, s);
    }
    return s;
  }

  /** Render one shot to a linear texture: through its post chain, or straight into a target. */
  private layer(shot: ShotScene, localT: number, target: THREE.WebGLRenderTarget): THREE.Texture {
    shot.apply(localT);
    if (shot.post) return shot.post.render(shot.focusDistance);
    const r = this.renderer;
    r.setRenderTarget(target);
    r.render(shot.scene, shot.camera);
    r.setRenderTarget(null);
    return target.texture;
  }

  /** Render the project at timeline time `t` (seconds). */
  renderAt(t: number): void {
    const layers = resolveAt(this.bundle!, t);
    const r = this.renderer;
    const first = layers[0]!;
    const a = this.layer(this.sceneFor(first.shotId), first.localT, this.rtA);
    const second = layers[1];
    const b = second ? this.layer(this.sceneFor(second.shotId), second.localT, this.rtB) : a;
    // post-chain textures live in the composers' buffers, which the next layer's chain does not touch,
    // so both are still valid here; convert to display colour once, after any dissolve
    r.setRenderTarget(null);
    this.quadMat.uniforms.uA!.value = a;
    this.quadMat.uniforms.uB!.value = b;
    this.quadMat.uniforms.uMix!.value = second ? second.alpha : 0;
    r.render(this.quadScene, this.quadCam);
    this.captions?.render(r, captionAt(this.captionLines, t));
  }
}
