import * as THREE from 'three';
import type { Actor } from '@shortstudio/schema';
import { faceTexture } from './face';
import type { ActorPose } from './pose';
import { ARM_SEGMENT, HEAD_HEIGHT, HIP_IDLE, HIP_SPREAD, LEG_SEGMENT, SHOULDER_SPREAD, SHOULDER_UP, twoBoneKnee, type V3 } from './rig';
import { createOutlineMaterial, createWhiteLiftMaterial } from './shaders';

const HEAD_R = HEAD_HEIGHT / 2;
const DOWN = new THREE.Vector3(0, -1, 0);

interface Leg {
  side: -1 | 1;
  thigh: THREE.Group;
  shin: THREE.Group;
  foot: THREE.Group;
}
interface Arm {
  shoulder: THREE.Group;
  elbow: THREE.Group;
}

/**
 * Chibi stickman with a real joint hierarchy:
 *   root -> pelvis -> { torso, head -> face, shoulder -> elbow (x2), hip -> knee -> foot (x2) }
 * Legs are solved with two-bone IK to world-space foot targets from the pure rig, so a planted foot stays put.
 */
export class Mannequin {
  readonly group = new THREE.Group();
  readonly toonMaterials: THREE.ShaderMaterial[] = [];
  private pelvis = new THREE.Group();
  private head = new THREE.Group();
  private face: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private arms: Record<'left' | 'right', Arm>;
  private legs: Leg[] = [];

  constructor(readonly actor: Actor) {
    this.group.position.set(...actor.position);
    this.group.rotation.y = actor.facingY;
    this.group.scale.setScalar(actor.scale);
    this.group.add(this.pelvis);
    this.pelvis.position.y = HIP_IDLE;

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

    // torso: the bean sits on the pelvis
    const torso = solid(new THREE.CapsuleGeometry(0.3, 0.45, 8, 24), body, this.pelvis);
    torso.position.y = 0.85 - HIP_IDLE;
    torso.scale.set(1, 1, 0.8);

    // head
    this.head.position.y = HEAD_HEIGHT;
    this.pelvis.add(this.head);
    solid(new THREE.SphereGeometry(HEAD_R, 40, 28), white, this.head);
    const faceGeo = new THREE.SphereGeometry(HEAD_R * 1.004, 32, 24, Math.PI / 2 - 0.62, 1.24, Math.PI / 2 - 0.47, 0.94);
    this.face = new THREE.Mesh(faceGeo, new THREE.MeshBasicMaterial({
      map: faceTexture('neutral', actor.glasses), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
    }));
    this.head.add(this.face);

    // legs: hip -> knee -> foot. The character's right is -x when it faces +z.
    for (const side of [-1, 1] as const) {
      const thigh = new THREE.Group();
      thigh.position.set(side * HIP_SPREAD, 0, 0);
      const thighStick = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, LEG_SEGMENT, 10), limb);
      thighStick.position.y = -LEG_SEGMENT / 2;
      thigh.add(thighStick);
      const shin = new THREE.Group();
      shin.position.y = -LEG_SEGMENT;
      const shinStick = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, LEG_SEGMENT, 10), limb);
      shinStick.position.y = -LEG_SEGMENT / 2;
      shin.add(shinStick, new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 10), limb)); // knee
      thigh.add(shin);
      const foot = new THREE.Group();
      foot.position.y = -LEG_SEGMENT;
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.07, 0.3), limb);
      shoe.position.set(0, 0.0, 0.07);
      foot.add(shoe);
      shin.add(foot);
      this.pelvis.add(thigh);
      this.legs.push({ side, thigh, shin, foot });
    }

    // arms: shoulder -> elbow -> hand
    const makeArm = (sx: -1 | 1): Arm => {
      const shoulder = new THREE.Group();
      shoulder.position.set(sx * SHOULDER_SPREAD, SHOULDER_UP, 0);
      const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, ARM_SEGMENT, 10), limb);
      upper.position.y = -ARM_SEGMENT / 2;
      shoulder.add(upper);
      const elbow = new THREE.Group();
      elbow.position.y = -ARM_SEGMENT;
      const fore = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.046, ARM_SEGMENT, 10), limb);
      fore.position.y = -ARM_SEGMENT / 2;
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), white);
      hand.position.y = -ARM_SEGMENT - 0.02;
      hand.add(new THREE.Mesh(hand.geometry, ink));
      elbow.add(fore, hand);
      shoulder.add(elbow);
      this.pelvis.add(shoulder);
      return { shoulder, elbow };
    };
    this.arms = { left: makeArm(1), right: makeArm(-1) };
  }

  private toon(color: string): THREE.ShaderMaterial {
    const m = createWhiteLiftMaterial(color);
    this.toonMaterials.push(m);
    return m;
  }

  applyPose(p: ActorPose): void {
    const { rig } = p;
    const scale = this.actor.scale;
    this.group.position.set(rig.root[0], rig.root[1], rig.root[2]);
    this.group.rotation.y = rig.yaw;
    this.pelvis.position.y = rig.hipY / scale;

    // arms: gesture weights set the shoulder, the walk swing opposes the legs, the elbow flexes with both
    const setArm = (arm: Arm, a: { raise: number; point: number }, swing: number, side: 1 | -1) => {
      arm.shoulder.rotation.z = side * (Math.PI * 0.75) * a.raise;
      arm.shoulder.rotation.x = -(Math.PI / 2) * a.point - swing;
      arm.elbow.rotation.x = -(0.5 * a.raise + 0.12 * a.point + 0.35 * Math.abs(swing));
    };
    setArm(this.arms.left, p.left, rig.armSwing.left, 1);
    setArm(this.arms.right, p.right, rig.armSwing.right, -1);
    this.head.rotation.x = 0.18 * p.headNod;

    const tex = faceTexture(p.face, this.actor.glasses);
    if (this.face.material.map !== tex) {
      this.face.material.map = tex;
      this.face.material.needsUpdate = true;
    }

    this.solveLegs(rig.feet);
  }

  /** Hanging legs when there are no foot targets; otherwise two-bone IK to each world-space foot. */
  private solveLegs(feet: { left: V3; right: V3 } | null): void {
    if (!feet) {
      for (const leg of this.legs) {
        leg.thigh.quaternion.identity();
        leg.shin.quaternion.identity();
        leg.foot.quaternion.identity();
      }
      return;
    }
    this.group.updateMatrixWorld(true);
    const qT = new THREE.Quaternion();
    const qS = new THREE.Quaternion();
    for (const leg of this.legs) {
      const target = leg.side === 1 ? feet.left : feet.right;
      const hip = new THREE.Vector3(leg.side * HIP_SPREAD, 0, 0); // pelvis space
      const foot = this.pelvis.worldToLocal(new THREE.Vector3(target[0], target[1], target[2]));
      const { knee } = twoBoneKnee([hip.x, hip.y, hip.z], [foot.x, foot.y, foot.z], LEG_SEGMENT, LEG_SEGMENT, [0, 0, 1]);
      const K = new THREE.Vector3(...knee);
      // reachable end of the shin (the foot target itself, unless the leg is fully stretched)
      const toFoot = foot.clone().sub(hip);
      const reach = Math.min(toFoot.length(), 2 * LEG_SEGMENT);
      const F = hip.clone().add(toFoot.normalize().multiplyScalar(reach));

      qT.setFromUnitVectors(DOWN, K.clone().sub(hip).normalize());
      qS.setFromUnitVectors(DOWN, F.clone().sub(K).normalize());
      leg.thigh.quaternion.copy(qT);
      leg.shin.quaternion.copy(qT.clone().invert().multiply(qS));
    }
    // feet stay level: cancel the leg's tilt so the shoe lies flat on the floor, pointing the way the body faces
    this.group.updateMatrixWorld(true);
    const shinWorld = new THREE.Quaternion();
    const bodyWorld = new THREE.Quaternion();
    this.pelvis.getWorldQuaternion(bodyWorld);
    for (const leg of this.legs) {
      leg.shin.getWorldQuaternion(shinWorld);
      leg.foot.quaternion.copy(shinWorld.invert().multiply(bodyWorld));
    }
  }
}
