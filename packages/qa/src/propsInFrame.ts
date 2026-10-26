import type { PropDef, Shot } from '@shortstudio/schema';
import { CAPTION_LINE, sampleTimes, type Issue } from './framing';
import { cameraAt, project } from './projection';

/**
 * Half width and height of each prop at scale 1 (see engine/propMeshes.ts), plus the height of its
 * visual centre above its position. A prop that is not fully visible can't make its point.
 */
export function propHalfExtent(p: PropDef): [number, number] {
  switch (p.kind) {
    case 'counter': {
      const pre = p.prefix ? 0.55 : 0;
      const suf = p.suffix ? 0.55 : 0;
      return [(p.digits * 0.5 + 0.5 + pre + suf) / 2, 0.65];
    }
    case 'dial':
    case 'clock':
      return [0.85, 0.85];
    case 'calendar':
      return [0.65, 0.875];
    case 'magnifier':
      return [0.73, 0.93];
  }
}

/** Props must sit fully inside the frame and above the caption zone for the whole shot. */
export function checkPropsInFrame(shot: Shot, aspect = 1080 / 1920): Issue[] {
  const issues: Issue[] = [];
  for (const prop of shot.props) {
    const [hw, hh] = propHalfExtent(prop);
    const [x, y, z] = prop.position;
    const c = Math.cos(prop.rotationY), s = Math.sin(prop.rotationY);
    let reported = false;
    for (const t of sampleTimes(shot.duration, 3)) {
      const cam = cameraAt(shot.camera, t);
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          const lx = sx * hw * prop.scale;
          const p = project(cam, [x + lx * c, y + sy * hh * prop.scale, z - lx * s], aspect);
          if (reported) continue;
          if (!p || Math.abs(p.x) > 1 || Math.abs(p.y) > 1) {
            reported = true;
            issues.push({
              check: 'prop-out-of-frame', severity: 'error', shot: shot.id,
              message: `${prop.kind} "${prop.id}" is cut off by the frame at ${t.toFixed(2)}s; scale it down, move it toward the centre, or pull the camera back`,
            });
          } else if ((1 - p.y) / 2 > CAPTION_LINE) {
            reported = true;
            issues.push({
              check: 'prop-under-caption', severity: 'error', shot: shot.id,
              message: `${prop.kind} "${prop.id}" reaches into the caption zone at ${t.toFixed(2)}s; raise it`,
            });
          }
        }
      }
    }
  }
  return issues;
}
