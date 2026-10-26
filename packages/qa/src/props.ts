import type { SetDef, Shot } from '@shortstudio/schema';
import { rigAt } from '@shortstudio/engine/pure';
import { HEAD_CENTER_Y, shotSampleTimes, type Issue } from './framing';
import { cameraAt, type V3 } from './projection';
import { segmentEntersBox, solidsOf, type Solid } from './solids';

/** Torso footprint radius at scale 1. */
export const BODY_RADIUS = 0.35;
/** Hips live in this height band (scale 1); props crossing it mean the actor is inside furniture. */
export const HIP_BAND: [number, number] = [0.3, 1.1];

/** A prop between the camera and an actor's head (raycast from camera to head). */
export function checkObjectOcclusion(shot: Shot, set: SetDef, samples = 3): Issue[] {
  const solids = solidsOf(set);
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const t of shotSampleTimes(shot, samples)) {
    const cam = cameraAt(shot.camera, t);
    for (const a of shot.actors) {
      const [x, jy, z] = rigAt(shot, a, shot.start + t).root;
      const head: V3 = [x, jy + a.scale * HEAD_CENTER_Y, z];
      for (const s of solids) {
        if (insideXZ(s, x, z, 0)) continue; // that is clipping, reported separately
        const hit = segmentEntersBox(cam.position, head, s);
        if (hit !== null && hit < 0.995) {
          const key = `${a.id}|${s.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          issues.push({
            check: 'object-occlusion', severity: 'error', shot: shot.id, actor: a.id,
            message: `"${s.id}" blocks the camera's view of ${a.id}'s head at ${t.toFixed(2)}s; shift the camera sideways or move the prop`,
          });
        }
      }
    }
  }
  return issues;
}

const insideXZ = (s: Solid, x: number, z: number, r: number) =>
  x + r > s.min[0] && x - r < s.max[0] && z + r > s.min[2] && z - r < s.max[2];

/** An actor standing inside a prop at hip height. */
export function checkClipping(shot: Shot, set: SetDef): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const t of shotSampleTimes(shot, 3)) {
    for (const a of shot.actors) {
      const [x, jy, z] = rigAt(shot, a, shot.start + t).root;
      for (const s of solidsOf(set)) {
        const lo = HIP_BAND[0] * a.scale + jy;
        const hi = HIP_BAND[1] * a.scale + jy;
        if (s.max[1] <= lo || s.min[1] >= hi) continue;
        if (insideXZ(s, x, z, BODY_RADIUS * a.scale) && !seen.has(`${a.id}|${s.id}`)) {
          seen.add(`${a.id}|${s.id}`);
          issues.push({
            check: 'prop-clipping', severity: 'error', shot: shot.id, actor: a.id,
            message: `${a.id} at (${x.toFixed(1)}, ${z.toFixed(1)}) at ${t.toFixed(2)}s is inside "${s.id}"; move the actor (or the walk path) out of the prop`,
          });
        }
      }
    }
  }
  return issues;
}
