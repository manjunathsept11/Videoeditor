import * as THREE from 'three';
import { projectDuration, type Bundle, type Shot } from '@shortstudio/schema';
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
import { buildSetObject } from './setbuilder';
import { updateWhiteLift } from './shaders';

class ShotScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private rig: LightRig;
  private actors: Mannequin[] = [];
  private props: { def: Shot['props'][number]; mesh: PropMesh }[] = [];
  private toon: THREE.ShaderMaterial[] = [];

  constructor(private shot: Shot, bundle: Bundle, aspect: number) {
    const set = bundle.sets[shot.set]!;
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
    for (const m of this.actors) m.applyPose(actorPoseAt(this.shot, m.actor.id, this.shot.start + localT));
    for (const { def, mesh } of this.props) mesh.apply(propStateAt(this.shot, def, this.shot.start + localT));
    for (const mat of this.toon) updateWhiteLift(mat, this.rig, this.camera);
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
    this.bundle = bundle;
    this.scenes.clear();
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
      s = new ShotScene(this.bundle!.shots[id]!, this.bundle!, this.width / this.height);
      this.scenes.set(id, s);
    }
    return s;
  }

  /** Render the project at timeline time `t` (seconds). */
  renderAt(t: number): void {
    const layers = resolveAt(this.bundle!, t);
    const r = this.renderer;
    if (layers.length === 1) {
      const s = this.sceneFor(layers[0]!.shotId);
      s.apply(layers[0]!.localT);
      r.setRenderTarget(null);
      r.render(s.scene, s.camera);
      this.captions?.render(r, captionAt(this.captionLines, t));
      return;
    }
    const [a, b] = layers as [(typeof layers)[number], (typeof layers)[number]];
    const sa = this.sceneFor(a.shotId);
    const sb = this.sceneFor(b.shotId);
    sa.apply(a.localT);
    sb.apply(b.localT);
    r.setRenderTarget(this.rtA); r.render(sa.scene, sa.camera);
    r.setRenderTarget(this.rtB); r.render(sb.scene, sb.camera);
    r.setRenderTarget(null);
    this.quadMat.uniforms.uA!.value = this.rtA.texture;
    this.quadMat.uniforms.uB!.value = this.rtB.texture;
    this.quadMat.uniforms.uMix!.value = b.alpha;
    r.render(this.quadScene, this.quadCam);
    this.captions?.render(r, captionAt(this.captionLines, t));
  }
}
