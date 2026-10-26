import { CANONICAL_FPS, type Shot } from '@shortstudio/schema';
import { rigAt, walkPlans } from '@shortstudio/engine/pure';
import { cameraAt, project, type V3 } from './projection';

export type Severity = 'error' | 'warning';

export interface Issue {
  check: string;
  severity: Severity;
  shot: string;
  actor?: string;
  message: string;
}

/** Mannequin dimensions (see engine/mannequin.ts), at scale 1. */
export const HEAD_CENTER_Y = 1.58;
export const HEAD_RADIUS = 0.5;
export const BODY_TOP_Y = HEAD_CENTER_Y + HEAD_RADIUS;
/** The eye line sits just above the head's centre; eyes are ~0.5 apart and ~0.12 tall. */
export const EYE_Y = HEAD_CENTER_Y + 0.05;
export const EYE_HALF_SPREAD = 0.26;
export const EYE_HALF_HEIGHT = 0.12;
/** Captions live in the lower 30% of the frame; a face below this line is covered. */
export const CAPTION_LINE = 0.7;

export interface FramingOptions {
  aspect?: number;
  /** Samples across the shot (start, end, and in between). */
  samples?: number;
}

export const sampleTimes = (duration: number, n: number): number[] =>
  Array.from({ length: Math.max(2, n) }, (_, s) => (duration * s) / (Math.max(2, n) - 1));

/**
 * Times (seconds into the shot) worth checking: evenly spread, plus the start, middle and end of every
 * walk and each jolt's peak, because that is where actors are somewhere new.
 */
export function shotSampleTimes(shot: Shot, n = 3): number[] {
  const ts = new Set(sampleTimes(shot.duration, n).map((t) => +t.toFixed(4)));
  const add = (t: number) => {
    const local = t - shot.start;
    if (local >= 0 && local <= shot.duration) ts.add(+local.toFixed(4));
  };
  for (const a of shot.actors) {
    for (const p of walkPlans(shot, a)) [p.t0, (p.t0 + p.t1) / 2, p.t1].forEach(add);
  }
  for (const e of shot.events) if (e.type === 'jolt') add(e.at + 0.07);
  return [...ts].sort((x, y) => x - y);
}

/**
 * Per-shot framing, evaluated at both ends of the shot because the camera creeps in the whole time.
 *  - eyes must be inside the frame (error); a cropped scalp with visible eyes is allowed for close-ups (warning)
 *  - faces must sit above the caption zone
 *  - nobody behind the camera
 */
export function checkFraming(shot: Shot, opts: FramingOptions = {}): Issue[] {
  const aspect = opts.aspect ?? 1080 / 1920;
  const issues: Issue[] = [];
  const seen = new Set<string>();
  const add = (i: Issue) => {
    const key = `${i.check}|${i.actor}`;
    if (!seen.has(key)) {
      seen.add(key);
      issues.push(i);
    }
  };

  for (const t of shotSampleTimes(shot, opts.samples ?? 3)) {
    const cam = cameraAt(shot.camera, t);
    const tanHalf = Math.tan((cam.fov * Math.PI) / 360);
    const when = `at ${t.toFixed(2)}s (frame ${Math.round(t * CANONICAL_FPS)})`;
    for (const a of shot.actors) {
      const [x, jy, z] = rigAt(shot, a, shot.start + t).root; // where the actor actually is at this moment
      const center = project(cam, [x, jy + a.scale * HEAD_CENTER_Y, z], aspect);
      if (!center) {
        add({ check: 'behind-camera', severity: 'error', shot: shot.id, actor: a.id, message: `${a.id} is behind the camera ${when}` });
        continue;
      }
      // eyes: the four corners of the eye box must be inside the frame
      let eyesOut = false;
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          const p = project(cam, [x + sx * a.scale * EYE_HALF_SPREAD, jy + a.scale * (EYE_Y + sy * EYE_HALF_HEIGHT), z], aspect);
          if (!p || Math.abs(p.x) > 1 || Math.abs(p.y) > 1) eyesOut = true;
        }
      }
      if (eyesOut) {
        add({
          check: 'head-cropped', severity: 'error', shot: shot.id, actor: a.id,
          message: `${a.id}'s eyes leave the frame ${when} (head centre x=${center.x.toFixed(2)}, y=${center.y.toFixed(2)}); move the camera back or the actor toward the centre`,
        });
      } else {
        const ry = (a.scale * HEAD_RADIUS) / (center.depth * tanHalf);
        const rx = ry / aspect;
        if (center.x - rx < -1 || center.x + rx > 1 || center.y - ry < -1 || center.y + ry > 1) {
          add({ check: 'scalp-cropped', severity: 'warning', shot: shot.id, actor: a.id, message: `${a.id}'s head is partly cropped ${when} (eyes still visible)` });
        }
      }
      const fromTop = (1 - center.y) / 2;
      if (fromTop > CAPTION_LINE) {
        add({
          check: 'caption-occlusion', severity: 'error', shot: shot.id, actor: a.id,
          message: `${a.id}'s face sits ${(fromTop * 100).toFixed(0)}% down the frame ${when}, under the caption zone (limit ${CAPTION_LINE * 100}%); tilt the camera down or aim it higher`,
        });
      }
    }
  }
  return issues;
}

export type { V3 };
