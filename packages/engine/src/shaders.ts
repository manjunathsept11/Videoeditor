import * as THREE from 'three';
import type { LightRig } from './lighting';

/**
 * WhiteLift: half-Lambert with a hard shadow floor. Plain Lambert smears muddy
 * grey across a white head; clamping half-Lambert to >= 0.2 keeps a clean slate
 * shadow, and the cyan rim adds the vivid edge tint.
 */
export function createWhiteLiftMaterial(color: THREE.ColorRepresentation): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uBase: { value: new THREE.Color(color) },
      uKeyDir: { value: new THREE.Vector3(0, 1, 0) }, // view space
      uKey: { value: new THREE.Color(1, 1, 1) },
      uFill: { value: new THREE.Color(0.4, 0.4, 0.4) },
      uRim: { value: new THREE.Color(0, 1, 1) },
      uRimStrength: { value: 0.9 },
      uFloor: { value: 0.2 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV;
      void main() {
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uBase, uKeyDir, uKey, uFill, uRim; uniform float uRimStrength, uFloor;
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec3 n = normalize(vN);
        float h = max(dot(n, normalize(uKeyDir)) * 0.5 + 0.5, uFloor);
        vec3 lit = mix(uFill, uKey, h);
        float rim = smoothstep(0.55, 1.0, 1.0 - max(dot(n, normalize(vV)), 0.0));
        vec3 col = uBase * lit + uRim * rim * uRimStrength;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
}

/** Inverted hull: back faces pushed out along the normal, flat black. */
export function createOutlineMaterial(thickness = 0.03): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uThickness: { value: thickness } },
    vertexShader: /* glsl */ `
      uniform float uThickness;
      void main() {
        vec3 p = position + normal * uThickness;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `void main() { gl_FragColor = vec4(0.02, 0.02, 0.03, 1.0); }`,
  });
}

/** Push the current camera/rig into a WhiteLift material (call once per render). */
export function updateWhiteLift(mat: THREE.ShaderMaterial, rig: LightRig, camera: THREE.Camera): void {
  const u = mat.uniforms as Record<string, { value: any }>;
  u.uKeyDir!.value.copy(rig.keyDir).transformDirection(camera.matrixWorldInverse);
  u.uKey!.value.copy(rig.keyColor);
  u.uFill!.value.copy(rig.fillColor);
  u.uRim!.value.copy(rig.rimColor);
  u.uRimStrength!.value = rig.rimStrength;
  u.uFloor!.value = rig.shadowFloor;
}
