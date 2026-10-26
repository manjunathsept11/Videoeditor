import type { SetDef, Shot } from '@shortstudio/schema';
import { HEAD_CENTER_Y, sampleTimes, type Issue } from './framing';
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
  for (const t of sampleTimes(shot.duration, samples)) {
    const cam = cameraAt(shot.camera, t);
    for (const a of shot.actors) {
      const head: V3 = [a.position[0], a.scale * HEAD_CENTER_Y, a.position[2]];
      for (const s of solids) {
        if (insideXZ(s, a.position[0], a.position[2], 0)) continue; // that is clipping, reported separately
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
  for (const a of shot.actors) {
    for (const s of solidsOf(set)) {
      const lo = HIP_BAND[0] * a.scale;
      const hi = HIP_BAND[1] * a.scale;
      if (s.max[1] <= lo || s.min[1] >= hi) continue;
      if (insideXZ(s, a.position[0], a.position[2], BODY_RADIUS * a.scale)) {
        issues.push({
          check: 'prop-clipping', severity: 'error', shot: shot.id, actor: a.id,
          message: `${a.id} at (${a.position[0].toFixed(1)}, ${a.position[2].toFixed(1)}) is inside "${s.id}"; move the actor out of the prop`,
        });
      }
    }
  }
  return issues;
}
