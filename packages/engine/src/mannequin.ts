import * as THREE from 'three';
import type { Actor } from '@shortstudio/schema';
import { faceTexture } from './face';
import type { ActorPose } from './pose';
import { createOutlineMaterial, createWhiteLiftMaterial } from './shaders';

const HEAD_R = 0.5;
const SHOULDER_Y = 1.22;

/** Chibi stickman: white sphere head + decal face, bean torso, stick limbs, ink outlines. */
export class Mannequin {
  readonly group = new THREE.Group();
  readonly toonMaterials: THREE.ShaderMaterial[] = [];
  private head = new THREE.Group();
  private face: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private arms: Record<'left' | 'right', THREE.Group>;

  constructor(readonly actor: Actor) {
    this.group.position.set(...actor.position);
    this.group.rotation.y = actor.facingY;
    this.group.scale.setScalar(actor.scale);

    const white = this.toon('#ffffff');
    const body = this.toon(actor.bodyColor);
    const ink = createOutlineMaterial(0.03);
    const limb = new THREE.MeshBasicMaterial({ color: 0x0a0a10 });

    const solid = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, outline = true) => {
      const m = new THREE.Mesh(geo, mat);
      parent.add(m);
      if (outline) m.add(new THREE.Mesh(geo, ink));
      return m;
    };

    // torso
    const torso = solid(new THREE.CapsuleGeometry(0.3, 0.45, 8, 24), body, this.group);
    torso.position.y = 0.85;
    torso.scale.set(1, 1, 0.8);

    // head
    this.head.position.y = 1.58;
    this.group.add(this.head);
    solid(new THREE.SphereGeometry(HEAD_R, 40, 28), white, this.head);

    // curved face decal hugging the sphere front (+z)
    const faceGeo = new THREE.SphereGeometry(HEAD_R * 1.004, 32, 24, Math.PI / 2 - 0.62, 1.24, Math.PI / 2 - 0.47, 0.94);
    this.face = new THREE.Mesh(faceGeo, new THREE.MeshBasicMaterial({
      map: faceTexture('neutral', actor.glasses), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
    }));
    this.head.add(this.face);

    // legs
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.5, 10), limb);
      leg.position.set(side * 0.14, 0.25, 0);
      this.group.add(leg);
    }

    // arms: pivot at the shoulder, hanging along -y
    const makeArm = (side: -1 | 1) => {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.36, SHOULDER_Y, 0);
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.62, 10), limb);
      stick.position.y = -0.31;
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), white);
      hand.position.y = -0.64;
      hand.add(new THREE.Mesh(hand.geometry, ink));
      pivot.add(stick, hand);
      this.group.add(pivot);
      return pivot;
    };
    // The character's right hand is on -x when it faces +z.
    this.arms = { left: makeArm(1), right: makeArm(-1) };
  }

  private toon(color: string): THREE.ShaderMaterial {
    const m = createWhiteLiftMaterial(color);
    this.toonMaterials.push(m);
    return m;
  }

  applyPose(p: ActorPose): void {
    const set = (arm: THREE.Group, a: { raise: number; point: number }, side: 1 | -1) => {
      arm.rotation.z = side * (Math.PI * 0.75) * a.raise;
      arm.rotation.x = -(Math.PI / 2) * a.point;
    };
    set(this.arms.left, p.left, 1);
    set(this.arms.right, p.right, -1);
    this.head.rotation.x = 0.18 * p.headNod;

    const tex = faceTexture(p.face, this.actor.glasses);
    if (this.face.material.map !== tex) {
      this.face.material.map = tex;
      this.face.material.needsUpdate = true;
    }
  }
}
