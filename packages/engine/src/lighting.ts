import * as THREE from 'three';
import type { LightingPreset } from '@shortstudio/schema';

export interface LightRig {
  /** World-space direction pointing from the subject toward the key light. */
  keyDir: THREE.Vector3;
  keyColor: THREE.Color;
  fillColor: THREE.Color;
  rimColor: THREE.Color;
  rimStrength: number;
  /** Toon "slate" shadow floor for half-Lambert (spec: 0.2). */
  shadowFloor: number;
}

/** Numbers from the doc: warm key 2.4x, cool fill 0.9x, cyan kicker rim 3.6x. */
export function applyLighting(scene: THREE.Scene, preset: LightingPreset): LightRig {
  if (preset === 'cinema') {
    const key = new THREE.DirectionalLight(0xffb066, 2.4);
    key.position.set(-3, 5, 6);
    const fill = new THREE.HemisphereLight(0x5577bb, 0x221133, 0.9);
    scene.add(key, fill);
    return {
      keyDir: key.position.clone().normalize(),
      keyColor: new THREE.Color(0xfff8f0), // near-neutral so white heads stay white
      fillColor: new THREE.Color(0x4a5a90).multiplyScalar(0.5),
      rimColor: new THREE.Color(0x00e5ff),
      rimStrength: 0.9, // 3.6 kicker scaled into the toon shader's 0..1 range
      shadowFloor: 0.2,
    };
  }
  scene.add(new THREE.AmbientLight(0xffffff, 1.6), Object.assign(new THREE.DirectionalLight(0xffffff, 0.8), { position: new THREE.Vector3(2, 4, 6) }));
  return {
    keyDir: new THREE.Vector3(2, 4, 6).normalize(),
    keyColor: new THREE.Color(0xffffff),
    fillColor: new THREE.Color(0xc8c8d0),
    rimColor: new THREE.Color(0xffffff),
    rimStrength: 0.15,
    shadowFloor: 0.2,
  };
}
