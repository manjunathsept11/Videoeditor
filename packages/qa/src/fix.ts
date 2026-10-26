import type { Camera, SetDef, Shot } from '@shortstudio/schema';
import { checkFraming, type Issue } from './framing';
import { checkFloorCoverage } from './floor';
import { checkFootSliding } from './feet';
import { checkPropsInFrame } from './propsInFrame';
import { checkClipping, checkObjectOcclusion } from './props';

export interface Patch {
  camera?: Camera;
  actors?: Record<string, [number, number, number]>;
}

export interface FixResult {
  shot: Shot;
  /** What was changed, in plain words. */
  fixes: string[];
  patch: Patch;
  remaining: Issue[];
}

const errors = (xs: Issue[]) => xs.filter((i) => i.severity === 'error');

/** Every automated check on one shot. */
export function checkShot(shot: Shot, set: SetDef): Issue[] {
  return [...checkFraming(shot), ...checkObjectOcclusion(shot, set), ...checkClipping(shot, set), ...checkFloorCoverage(shot, set), ...checkPropsInFrame(shot), ...checkFootSliding(shot)];
}

const withCamera = (s: Shot, camera: Camera): Shot => ({ ...s, camera });

/** Pull back / re-aim until framing passes. Smallest change wins. */
function fixFraming(shot: Shot): { shot: Shot; note: string } | null {
  if (errors(checkFraming(shot)).length === 0) return null;
  const cam = shot.camera;
  const cx = shot.actors.length ? shot.actors.reduce((s, a) => s + a.position[0], 0) / shot.actors.length : cam.target[0];
  let best: { cost: number; cam: Camera } | null = null;
  for (let s = 1; s <= 2.5001; s += 0.1) {
    for (const dy of [0, -0.3, -0.6, -0.9, -1.2, 0.3, 0.6]) {
      for (const centre of [false, true]) {
        const dx = centre ? cx - cam.target[0] : 0;
        const target: [number, number, number] = [cam.target[0] + dx, cam.target[1] + dy, cam.target[2]];
        const position: [number, number, number] = [
          target[0] + (cam.position[0] - cam.target[0]) * s,
          target[1] + (cam.position[1] - cam.target[1]) * s,
          target[2] + (cam.position[2] - cam.target[2]) * s,
        ];
        const next: Camera = { ...cam, target, position };
        if (errors(checkFraming(withCamera(shot, next))).length) continue;
        const cost = (s - 1) * 10 + Math.abs(dy) + Math.abs(dx) * 0.5;
        if (!best || cost < best.cost) best = { cost, cam: next };
      }
    }
  }
  if (!best) return null;
  return { shot: withCamera(shot, best.cam), note: `re-framed camera (pulled back/re-aimed) to keep eyes in frame and above the caption zone` };
}

/** Slide the camera sideways (along the viewing arc) until no prop blocks any head. */
function fixOcclusion(shot: Shot, set: SetDef): { shot: Shot; note: string } | null {
  if (checkObjectOcclusion(shot, set).length === 0) return null;
  const cam = shot.camera;
  const f = [cam.target[0] - cam.position[0], 0, cam.target[2] - cam.position[2]];
  const len = Math.hypot(f[0]!, f[2]!) || 1;
  const right: [number, number, number] = [-f[2]! / len, 0, f[0]! / len]; // f x up, flattened
  for (let off = 0.5; off <= 5.0001; off += 0.5) {
    for (const sign of [1, -1]) {
      const position: [number, number, number] = [
        cam.position[0] + sign * off * right[0],
        cam.position[1],
        cam.position[2] + sign * off * right[2],
      ];
      const next = withCamera(shot, { ...cam, position });
      if (checkObjectOcclusion(next, set).length === 0 && errors(checkFraming(next)).length === 0) {
        return { shot: next, note: `moved camera ${off.toFixed(1)} units ${sign > 0 ? 'right' : 'left'} so no prop blocks the actors` };
      }
    }
  }
  return null;
}

/** Walk an actor out of a prop, nearest free spot first (toward the camera preferred). */
function fixClipping(shot: Shot, set: SetDef): { shot: Shot; note: string } | null {
  if (checkClipping(shot, set).length === 0) return null;
  let cur = shot;
  const notes: string[] = [];
  for (const a of shot.actors) {
    const test = (pos: [number, number, number]) =>
      checkClipping({ ...cur, actors: cur.actors.map((x) => (x.id === a.id ? { ...x, position: pos } : x)) }, set).every((i) => i.actor !== a.id);
    if (test(a.position)) continue;
    outer: for (let d = 0.1; d <= 6; d += 0.1) {
      for (const [dx, dz] of [[0, d], [d, 0], [-d, 0], [0, -d]] as const) {
        const pos: [number, number, number] = [a.position[0] + dx, a.position[1], a.position[2] + dz];
        if (test(pos)) {
          cur = { ...cur, actors: cur.actors.map((x) => (x.id === a.id ? { ...x, position: pos } : x)) };
          notes.push(`moved ${a.id} out of a prop to (${pos[0].toFixed(1)}, ${pos[2].toFixed(1)})`);
          break outer;
        }
      }
    }
  }
  return notes.length ? { shot: cur, note: notes.join('; ') } : null;
}

/** Auto-fix in dependency order (positions, then framing, then occlusion), re-checking after each step. */
export function fixShot(shot: Shot, set: SetDef): FixResult {
  let cur = shot;
  const fixes: string[] = [];
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const step of [() => fixClipping(cur, set), () => fixFraming(cur), () => fixOcclusion(cur, set)]) {
      const r = step();
      if (r) {
        cur = r.shot;
        fixes.push(r.note);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const patch: Patch = {};
  if (JSON.stringify(cur.camera) !== JSON.stringify(shot.camera)) patch.camera = cur.camera;
  const moved = cur.actors.filter((a, i) => JSON.stringify(a.position) !== JSON.stringify(shot.actors[i]!.position));
  if (moved.length) patch.actors = Object.fromEntries(moved.map((a) => [a.id, a.position]));
  return { shot: cur, fixes, patch, remaining: checkShot(cur, set) };
}
