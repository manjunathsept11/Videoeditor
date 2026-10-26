import type { Camera } from '@shortstudio/schema';

export type V3 = readonly [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Camera at `localT` seconds into a shot, including the constant dolly-in (apparent scale = 1 + creep * t). */
export function cameraAt(cam: Camera, localT: number): { position: V3; target: V3; fov: number } {
  const k = 1 / (1 + cam.creep * Math.max(0, localT));
  const [px, py, pz] = cam.position;
  const [tx, ty, tz] = cam.target;
  return { position: [tx + (px - tx) * k, ty + (py - ty) * k, tz + (pz - tz) * k], target: cam.target, fov: cam.fov };
}

export interface Projected {
  /** -1..1 across the frame (left..right). */
  x: number;
  /** -1..1 down the frame (bottom..top). */
  y: number;
  /** Distance in front of the camera. */
  depth: number;
}

/** Project a world point to normalized device coordinates. Null when behind the camera. */
export function project(cam: { position: V3; target: V3; fov: number }, point: V3, aspect: number): Projected | null {
  const f = norm(sub(cam.target, cam.position));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const d = sub(point, cam.position);
  const depth = dot(d, f);
  if (depth <= 0.05) return null;
  const t = Math.tan((cam.fov * Math.PI) / 360);
  return { x: dot(d, r) / (depth * t * aspect), y: dot(d, u) / (depth * t), depth };
}
