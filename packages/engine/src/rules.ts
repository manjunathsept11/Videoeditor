/**
 * The six animation rules from the architecture doc, as pure functions of time.
 * Nothing here is stateful: every value is a closed-form function of `t`, so a
 * frame can be rendered in isolation and exports are bit-for-bit repeatable.
 *
 * Authoring grid is 30fps. Rules are expressed in canonical frames and converted
 * to seconds, so a 60fps export keeps identical timing.
 */
import { CANONICAL_FPS, type ExpressionId } from '@shortstudio/schema';

export const FRAME = 1 / CANONICAL_FPS;

export const GESTURE_LEAD_FRAMES = 4; // rule 2: land 3-5 frames before the word
export const GESTURE_RISE_FRAMES = 5;
export const GESTURE_FALL_FRAMES = 5;
export const HEAD_LAG_FRAMES = 3; // rule 2b: head trails hand by 2-4 frames
export const CAMERA_CREEP_RATE = 0.05; // rule 4
export const DISSOLVE_FRAMES = 6; // rule 5
export const HOLD_MAX_DRIFT_PX = 0.5; // rule 1

export const toFrame = (t: number): number => Math.round(t * CANONICAL_FPS);

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const k = clamp01((x - edge0) / (edge1 - edge0));
  return k * k * (3 - 2 * k);
}

// ------------------------------------------------------------ rule 2 / 2b

export interface GestureTiming {
  lead?: number;
  rise?: number;
  fall?: number;
  hold?: number;
}

/** Time the arm must be fully in place: `lead` frames before the spoken word. */
export function gestureLandTime(wordT: number, lead = GESTURE_LEAD_FRAMES): number {
  return wordT - lead * FRAME;
}

/** 0 at rest, 1 fully extended. Pre-timed so the gesture has landed before the word. */
export function gestureWeight(t: number, wordT: number, opts: GestureTiming = {}): number {
  const { lead = GESTURE_LEAD_FRAMES, rise = GESTURE_RISE_FRAMES, fall = GESTURE_FALL_FRAMES, hold = 0.8 } = opts;
  const land = gestureLandTime(wordT, lead);
  const up = smoothstep(land - rise * FRAME, land, t);
  const down = smoothstep(land + hold, land + hold + fall * FRAME, t);
  return up * (1 - down);
}

/** Head follow-through: the same envelope, delayed by a few frames. */
export function headLagWeight(t: number, wordT: number, opts: GestureTiming = {}): number {
  return gestureWeight(t - HEAD_LAG_FRAMES * FRAME, wordT, opts);
}

// ----------------------------------------------------------------- rule 3

export type FaceState = ExpressionId | 'blink_half' | 'blink_full';

export interface ExpressionCue {
  at: number;
  expression: ExpressionId;
}

/**
 * Two-frame close, then snap: frame-2 half-closed, frame-1 fully closed,
 * frame 0 the new expression. No tweening between decals.
 */
export function faceStateAt(cues: readonly ExpressionCue[], t: number, initial: ExpressionId = 'neutral'): FaceState {
  const f = toFrame(t);
  const sorted = [...cues].sort((a, b) => a.at - b.at);
  let current: ExpressionId = initial;
  for (const c of sorted) {
    const fc = toFrame(c.at);
    if (fc <= f) current = c.expression;
    else {
      if (fc - f === 1) return 'blink_full';
      if (fc - f === 2) return 'blink_half';
      break;
    }
  }
  return current;
}

// ----------------------------------------------------------------- rule 4

/** Apparent zoom factor at `localT` seconds into a shot: scale = 1 + rate * dt. */
export function cameraCreepScale(localT: number, rate = CAMERA_CREEP_RATE): number {
  return 1 + rate * Math.max(0, localT);
}

// ----------------------------------------------------------------- rule 5

export interface DissolveWindow {
  /** Window is centred on the cut so neither shot is delayed. */
  from: number;
  to: number;
}

export function dissolveWindow(cutT: number, frames = DISSOLVE_FRAMES): DissolveWindow {
  const half = (frames * FRAME) / 2;
  return { from: cutT - half, to: cutT + half };
}

/** Opacity of the incoming shot, 0..1, linear over `frames`. */
export function dissolveAlpha(t: number, cutT: number, frames = DISSOLVE_FRAMES): number {
  const w = dissolveWindow(cutT, frames);
  return clamp01((t - w.from) / (w.to - w.from));
}

// ----------------------------------------------------------------- rule 6

export interface SpringOpts {
  /** Damping ratio. 0.59 gives ~10% overshoot (spec: dial needle). */
  zeta?: number;
  /** Natural frequency, rad/s. */
  omega?: number;
}

/**
 * Closed-form underdamped spring step response from `from` to `to`, starting at
 * `startT`. Pure function of t, so a counter lands on an exact frame.
 */
export function springValue(t: number, startT: number, from: number, to: number, opts: SpringOpts = {}): number {
  const { zeta = 0.59, omega = 18 } = opts;
  const dt = t - startT;
  if (dt <= 0) return from;
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const decay = Math.exp(-zeta * omega * dt);
  const k = 1 - decay * (Math.cos(wd * dt) + ((zeta * omega) / wd) * Math.sin(wd * dt));
  return from + (to - from) * k;
}

/** Peak overshoot fraction of an underdamped spring. */
export const springOvershoot = (zeta: number): number => Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta));

// ----------------------------------------------------------------- rule 1

/** Largest per-frame displacement across a sampled track; holds must stay under HOLD_MAX_DRIFT_PX. */
export function maxDriftPerFrame(samples: readonly (readonly number[])[]): number {
  let max = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    let d = 0;
    for (let k = 0; k < a.length; k++) d += (b[k]! - a[k]!) ** 2;
    max = Math.max(max, Math.sqrt(d));
  }
  return max;
}
