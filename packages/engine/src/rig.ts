/**
 * Body motion as pure functions of time: root path, walk cycle, hip bob, foot placement, jolt.
 *
 * Foot lock is true by construction: every planted foot is ONE fixed world point for its whole stance,
 * and the legs are solved to reach it (two-bone IK), so a foot cannot slide. `reachProblems` reports
 * the only way it could: a stride the legs cannot span.
 *
 * Everything here is in world units for an actor of `scale`; geometry constants are for scale 1.
 */
import type { Actor, Shot } from '@shortstudio/schema';
import { FRAME, smoothstep } from './rules';

// ---- body dimensions (shared with the mannequin mesh and the quality gate)
export const LEG_SEGMENT = 0.29; // thigh and shin
export const LEG_LENGTH = LEG_SEGMENT * 2;
export const HIP_IDLE = 0.58; // straight legs
export const HIP_SPREAD = 0.14;
export const HEAD_HEIGHT = 1.0;
export const ARM_SEGMENT = 0.32; // upper arm and forearm
export const SHOULDER_UP = 0.64; // shoulders above the hips
export const SHOULDER_SPREAD = 0.36;

// ---- walk (spec: step every 5-6 frames, 7% of head height bob)
export const STEP_FRAMES = 5.5;
export const BOB = 0.07 * HEAD_HEIGHT;
export const HIP_MID = 0.515; // mean hip height while walking
export const FOOT_LIFT = 0.12;
/** The turn into the heading (and back) is spread over this many steps, so a planted foot never has to twist under the hip. */
export const TURN_STEPS = 2;
export const ARM_SWING = 0.5;

// ---- jolt (spec: 50% of head height in 2 frames)
export const JOLT_RISE_FRAMES = 2;
export const JOLT_HOLD_FRAMES = 2;
export const JOLT_FALL_FRAMES = 3;

export type V3 = [number, number, number];
type Walk = Extract<Shot['events'][number], { type: 'walk' }>;
type Jolt = Extract<Shot['events'][number], { type: 'jolt' }>;

export interface RigState {
  /** World position of the root (on the floor, plus any jolt). */
  root: V3;
  /** Facing about y, radians; 0 faces +z. */
  yaw: number;
  /** Hip height above the root. */
  hipY: number;
  /** World targets for the planted/swinging feet while walking; null means legs just hang. */
  feet: { left: V3; right: V3 } | null;
  /** Arm swing about x, radians, per arm (opposes the legs). */
  armSwing: { left: number; right: number };
  walking: boolean;
}

// ----------------------------------------------------------------- geometry helpers

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** A point `lx` to the side of `p` for an actor facing `yaw` (the character's left is local +x). */
const sideOf = (p: [number, number], lx: number, yaw: number): [number, number] => [p[0] + lx * Math.cos(yaw), p[1] - lx * Math.sin(yaw)];

// ------------------------------------------------------------------------ walk plan

export interface WalkPlan {
  t0: number;
  t1: number;
  /** Steps, and seconds per step (5-6 frames). */
  n: number;
  Ts: number;
  from: [number, number];
  to: [number, number];
  dist: number;
  heading: number;
  yaw0: number;
  yawEnd: number;
  turn: boolean;
  /** Foot landing points P[-1..n]; index with k+1. */
  landings: [number, number][];
}

/** Position along the path after the speed ramps up over one step and down over the last. */
function travelled(plan: WalkPlan, t: number): number {
  const { t0, t1, Ts, dist } = plan;
  const D = t1 - t0;
  const vmax = dist / (D - Ts);
  const tau = Math.min(D, Math.max(0, t - t0));
  if (tau < Ts) return (0.5 * vmax * tau * tau) / Ts;
  if (tau <= D - Ts) return 0.5 * vmax * Ts + vmax * (tau - Ts);
  return dist - (0.5 * vmax * (D - tau) * (D - tau)) / Ts;
}

const pathPoint = (plan: WalkPlan, t: number): [number, number] => {
  const s = plan.dist === 0 ? 0 : travelled(plan, t) / plan.dist;
  return [lerp(plan.from[0], plan.to[0], s), lerp(plan.from[1], plan.to[1], s)];
};

export function planWalk(from: [number, number], yaw0: number, e: Walk, scale = 1): WalkPlan {
  const D = e.until - e.at;
  const n = Math.max(2, Math.round(D / (STEP_FRAMES * FRAME)));
  const Ts = D / n;
  const dx = e.to[0] - from[0];
  const dz = e.to[1] - from[1];
  const dist = Math.hypot(dx, dz);
  const heading = dist < 1e-9 ? yaw0 : Math.atan2(dx, dz);
  const yawEnd = yaw0;
  const plan: WalkPlan = { t0: e.at, t1: e.until, n, Ts, from, to: e.to, dist, heading, yaw0, yawEnd, turn: e.turn && dist > 1e-9, landings: [] };

  // k even plants the right foot (local -x), k odd the left (+x).
  const lat = (k: number) => (k % 2 === 0 ? -1 : 1) * HIP_SPREAD * scale;
  const L: [number, number][] = [];
  L[0] = sideOf(from, lat(-1), yaw0); // P[-1]: the other foot, where it stands at the start
  L[1] = sideOf(from, lat(0), yaw0); // P[0]: first planted foot stays put
  for (let k = 1; k <= n - 2; k++) L[k + 1] = sideOf(pathPoint(plan, e.at + k * Ts + Ts / 2), lat(k), plan.turn ? heading : yaw0);
  L[n] = sideOf(e.to, lat(n - 1), yawEnd); // P[n-1]: final stance
  L[n + 1] = sideOf(e.to, lat(n), yawEnd); // P[n]: closes the stance
  plan.landings = L;
  return plan;
}

/**
 * Yaw while walking: turn into the heading over the first two steps and back over the last two, so the
 * actor is already facing their original way when the final feet land (no twisting after the walk ends).
 */
function walkYaw(plan: WalkPlan, t: number): number {
  if (!plan.turn) return plan.yaw0;
  const into = wrapAngle(plan.heading - plan.yaw0);
  const a = smoothstep(plan.t0, plan.t0 + TURN_STEPS * plan.Ts, t);
  const b = smoothstep(plan.t1 - TURN_STEPS * plan.Ts, plan.t1, t);
  return plan.yaw0 + into * a * (1 - b);
}

/** Weight 0..1 that fades the walking motion in over the first step and out over the last. */
const walkWeight = (plan: WalkPlan, t: number): number =>
  Math.min(smoothstep(plan.t0, plan.t0 + plan.Ts, t), 1 - smoothstep(plan.t1 - plan.Ts, plan.t1, t));

interface WalkSample {
  root: [number, number];
  yaw: number;
  hipY: number;
  feet: { left: V3; right: V3 };
  armSwing: { left: number; right: number };
}

function sampleWalk(plan: WalkPlan, t: number, scale: number): WalkSample {
  const root = pathPoint(plan, t);
  const yaw = walkYaw(plan, t);
  const w = walkWeight(plan, t);
  const tau = t - plan.t0;
  const k = Math.min(plan.n - 1, Math.max(0, Math.floor(tau / plan.Ts)));
  const u = Math.min(1, Math.max(0, (tau - k * plan.Ts) / plan.Ts));

  // hips: highest at mid-stance, lowest at heel strike, 7% of head height peak to peak
  const bob = HIP_MID + (BOB / 2) * Math.cos(2 * Math.PI * (u - 0.5));
  const hipY = lerp(HIP_IDLE, bob, w) * scale;

  const P = (i: number) => plan.landings[i + 1]!;
  const planted = P(k);
  const swingFrom = P(k - 1);
  const swingTo = P(k + 1);
  const e = smoothstep(0, 1, u);
  const swing: V3 = [lerp(swingFrom[0], swingTo[0], e), FOOT_LIFT * scale * Math.sin(Math.PI * u), lerp(swingFrom[1], swingTo[1], e)];
  const stance: V3 = [planted[0], 0, planted[1]];
  // even k: right foot planted, left swinging; odd k: the reverse
  const feet = k % 2 === 0 ? { right: stance, left: swing } : { left: stance, right: swing };

  // arms swing opposite to the legs; one swing per step-pair
  const phase = Math.cos(Math.PI * (tau / plan.Ts));
  const arm = ARM_SWING * w * phase;
  return { root, yaw, hipY, feet, armSwing: { left: arm, right: -arm } };
}

// ------------------------------------------------------------------------------ jolt

/** Vertical offset of a jolt: up fast, hold, settle back. */
export function joltOffset(t: number, at: number, height: number, scale = 1): number {
  const A = height * HEAD_HEIGHT * scale;
  const dt = t - at;
  const rise = JOLT_RISE_FRAMES * FRAME;
  const hold = JOLT_HOLD_FRAMES * FRAME;
  const fall = JOLT_FALL_FRAMES * FRAME;
  if (dt <= 0 || dt >= rise + hold + fall) return 0;
  if (dt < rise) {
    const u = dt / rise;
    return A * (1 - (1 - u) * (1 - u)); // ease out: snaps up
  }
  if (dt < rise + hold) return A;
  const v = (dt - rise - hold) / fall;
  return A * (1 - v * v); // ease in: drops
}

// ---------------------------------------------------------------------------- aggregate

/** Walks for one actor in time order, each starting where the last ended. */
export function walkPlans(shot: Shot, actor: Actor): WalkPlan[] {
  const walks = shot.events.filter((e): e is Walk => e.type === 'walk' && e.actor === actor.id).sort((a, b) => a.at - b.at);
  const plans: WalkPlan[] = [];
  let at: [number, number] = [actor.position[0], actor.position[2]];
  for (const w of walks) {
    const p = planWalk(at, actor.facingY, w, actor.scale);
    plans.push(p);
    at = w.to;
  }
  return plans;
}

export function rigAt(shot: Shot, actor: Actor, t: number): RigState {
  const plans = walkPlans(shot, actor);
  let root: [number, number] = [actor.position[0], actor.position[2]];
  let yaw = actor.facingY;
  let hipY = HIP_IDLE * actor.scale;
  let feet: RigState['feet'] = null;
  let armSwing = { left: 0, right: 0 };
  let walking = false;

  for (const p of plans) {
    if (t < p.t0) break;
    if (t > p.t1) {
      root = p.to; // arrived, facing the original way, feet already in the idle stance
      continue;
    }
    const s = sampleWalk(p, t, actor.scale);
    root = s.root;
    yaw = s.yaw;
    hipY = s.hipY;
    feet = s.feet;
    armSwing = s.armSwing;
    walking = true;
    break;
  }

  let y = 0;
  for (const e of shot.events) if (e.type === 'jolt' && e.actor === actor.id) y += joltOffset(t, e.at, (e as Jolt).height, actor.scale);
  if (y > 0) feet = null; // airborne: legs hang with the body
  return { root: [root[0], y, root[1]], yaw, hipY, feet, armSwing, walking };
}

// ------------------------------------------------------------------------------- IK

export interface Knee {
  knee: V3;
  /** True when the foot was out of reach and the leg is fully stretched (the foot would be pulled off its plant). */
  overstretched: boolean;
}

/** Two-bone IK: the knee position for a hip and foot target, bending toward `pole`. */
export function twoBoneKnee(hip: V3, foot: V3, l1: number, l2: number, pole: V3): Knee {
  const d: V3 = [foot[0] - hip[0], foot[1] - hip[1], foot[2] - hip[2]];
  const raw = Math.hypot(...d) || 1e-9;
  const overstretched = raw > l1 + l2 + 1e-9;
  const dist = Math.min(l1 + l2 - 1e-9, Math.max(Math.abs(l1 - l2) + 1e-9, raw));
  const u: V3 = [d[0] / raw, d[1] / raw, d[2] / raw];
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  // pole made perpendicular to the leg axis
  const dp = pole[0] * u[0] + pole[1] * u[1] + pole[2] * u[2];
  let q: V3 = [pole[0] - u[0] * dp, pole[1] - u[1] * dp, pole[2] - u[2] * dp];
  const ql = Math.hypot(...q) || 1;
  q = [q[0] / ql, q[1] / ql, q[2] / ql];
  return { knee: [hip[0] + u[0] * a + q[0] * h, hip[1] + u[1] * a + q[1] * h, hip[2] + u[2] * a + q[2] * h], overstretched };
}

/** World position of a hip joint (`side` -1 right, +1 left). */
export function hipWorld(rig: RigState, scale: number, side: -1 | 1): V3 {
  const [x, z] = sideOf([rig.root[0], rig.root[2]], side * HIP_SPREAD * scale, rig.yaw);
  return [x, rig.root[1] + rig.hipY, z];
}

export interface ReachProblem {
  /** Seconds into the project. */
  t: number;
  actor: string;
  /** How far beyond the legs' reach the foot target was, world units. */
  short: number;
}

/**
 * Frames where a planted foot is out of the legs' reach, i.e. where foot lock would break and the foot slide.
 * Samples every canonical frame of every walk of every actor.
 */
export function reachProblems(shot: Shot): ReachProblem[] {
  const out: ReachProblem[] = [];
  for (const actor of shot.actors) {
    for (const plan of walkPlans(shot, actor)) {
      const maxReach = LEG_LENGTH * actor.scale;
      let worst = 0;
      let worstT = plan.t0;
      for (let t = plan.t0; t <= plan.t1; t += FRAME) {
        const r = rigAt(shot, actor, t);
        if (!r.feet) continue;
        for (const [foot, side] of [[r.feet.left, 1], [r.feet.right, -1]] as const) {
          const h = hipWorld(r, actor.scale, side);
          const d = Math.hypot(foot[0] - h[0], foot[1] - h[1], foot[2] - h[2]);
          if (d - maxReach > worst) {
            worst = d - maxReach;
            worstT = t;
          }
        }
      }
      if (worst > 1e-6) out.push({ t: worstT, actor: actor.id, short: worst });
    }
  }
  return out;
}
