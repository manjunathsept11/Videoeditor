import type { SetDef, Shot } from '@shortstudio/schema';
import { cameraAt, type V3 } from './projection';
import { sampleTimes, type Issue } from './framing';

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * Where the ray through NDC point (x, y) meets the ground plane y=0, or null when it never does
 * (it points at or above the horizon).
 */
export function groundHit(cam: { position: V3; target: V3; fov: number }, x: number, y: number, aspect: number): [number, number] | null {
  const f = norm(sub(cam.target, cam.position));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const t = Math.tan((cam.fov * Math.PI) / 360);
  const d: V3 = [f[0] + r[0] * x * t * aspect + u[0] * y * t, f[1] + r[1] * x * t * aspect + u[1] * y * t, f[2] + r[2] * x * t * aspect + u[2] * y * t];
  if (d[1] >= -1e-6) return null;
  const k = -cam.position[1] / d[1];
  return [cam.position[0] + d[0] * k, cam.position[2] + d[2] * k];
}

/** A floor plane's footprint: PlaneGeometry [w, d] centred on `position`. */
const covers = (o: Extract<SetDef['objects'][number], { kind: 'floor' }>, x: number, z: number) =>
  Math.abs(x - o.position[0]) <= o.size[0] / 2 && Math.abs(z - o.position[2]) <= o.size[1] / 2;

/**
 * The bottom of the frame must stand on floor, not on the void below the set. Rays through the bottom
 * corners and centre must land on a floor (if they land on the ground at all).
 */
export function checkFloorCoverage(shot: Shot, set: SetDef, aspect = 1080 / 1920): Issue[] {
  const floors = set.objects.filter((o): o is Extract<typeof o, { kind: 'floor' }> => o.kind === 'floor');
  const issues: Issue[] = [];
  for (const t of sampleTimes(shot.duration, 3)) {
    const cam = cameraAt(shot.camera, t);
    for (const x of [-1, 0, 1]) {
      const hit = groundHit(cam, x, -1, aspect);
      if (!hit) continue;
      if (!floors.some((f) => covers(f, hit[0], hit[1]))) {
        issues.push({
          check: 'floor-gap', severity: 'error', shot: shot.id,
          message: `the bottom of the frame at ${t.toFixed(2)}s lands on ground at (x=${hit[0].toFixed(1)}, z=${hit[1].toFixed(1)}) where set "${set.id}" has no floor; extend the floor toward the camera (it should reach at least z=${Math.ceil(hit[1] + 1)}) or aim the camera higher`,
        });
        return issues; // one report is enough
      }
    }
  }
  return issues;
}

type Floor = Extract<SetDef['objects'][number], { kind: 'floor' }>;

/**
 * Widen a set's floor so every shot that uses the set stands on it. A floor gap is a set problem a shot
 * can't fix, so this repairs the set: the first floor grows to cover the uncovered ground (plus a margin),
 * or a floor is added if the set has none. Returns null when nothing is uncovered.
 */
export function fixSetFloor(set: SetDef, shots: readonly Shot[], aspect = 1080 / 1920): { set: SetDef; note: string } | null {
  const floors = set.objects.filter((o): o is Floor => o.kind === 'floor');
  const hits: [number, number][] = [];
  for (const shot of shots) {
    for (const t of sampleTimes(shot.duration, 3)) {
      const cam = cameraAt(shot.camera, t);
      for (const x of [-1, -0.5, 0, 0.5, 1]) {
        const h = groundHit(cam, x, -1, aspect);
        if (h && !floors.some((f) => covers(f, h[0], h[1]))) hits.push(h);
      }
    }
  }
  if (hits.length === 0) return null;

  const margin = 2;
  let [minX, maxX, minZ, maxZ] = [Infinity, -Infinity, Infinity, -Infinity];
  const grow = (x0: number, x1: number, z0: number, z1: number) => {
    minX = Math.min(minX, x0); maxX = Math.max(maxX, x1); minZ = Math.min(minZ, z0); maxZ = Math.max(maxZ, z1);
  };
  for (const [x, z] of hits) grow(x - margin, x + margin, z - margin, z + margin);
  const first = floors[0];
  if (first) grow(first.position[0] - first.size[0] / 2, first.position[0] + first.size[0] / 2, first.position[2] - first.size[1] / 2, first.position[2] + first.size[1] / 2);

  const grown = { size: [maxX - minX, maxZ - minZ] as [number, number], position: [(minX + maxX) / 2, first?.position[1] ?? 0, (minZ + maxZ) / 2] as [number, number, number] };
  const objects: SetDef['objects'] = first
    ? set.objects.map((o) => (o === first ? { ...first, ...grown } : o))
    : [{ kind: 'floor', id: 'ground', color: '#1a1a2a', ...grown }, ...set.objects];
  return { set: { ...set, objects }, note: `extended the floor of set "${set.id}" to cover the bottom of the frame (now ${grown.size[0].toFixed(0)}x${grown.size[1].toFixed(0)} centred at z=${grown.position[2].toFixed(1)})` };
}
