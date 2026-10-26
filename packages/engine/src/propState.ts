/**
 * Number props as pure functions of time (rule 6: physical facts reach their value on the exact spoken frame).
 *
 * Every prop value is a chain of springs. A spring for an event at word time `at` is started `springRiseTime`
 * earlier, so the value FIRST TOUCHES its target exactly on the word's frame, then overshoots ~10% and settles.
 */
import type { PropDef, PropEvent, Shot } from '@shortstudio/schema';
import { CANONICAL_FPS } from '@shortstudio/schema';
import { clamp01, smoothstep, springRiseTime, springValue, toFrame, type SpringOpts } from './rules';

export const PROP_SPRING: Required<SpringOpts> = { zeta: 0.59, omega: 18 };
/** The lens glides rather than bounces. */
export const LENS_SPRING: Required<SpringOpts> = { zeta: 0.85, omega: 14 };

export interface Key {
  at: number;
  value: number;
}

/** Snap a spoken time onto the canonical frame grid so a value lands on a real frame. */
export const snapToFrame = (t: number): number => toFrame(t) / CANONICAL_FPS;

/**
 * Value of a spring chain at time t. Keys must be sorted by `at`. When one spring starts before the
 * previous one has settled, it continues from where that one currently is (position-continuous).
 */
export function chainValue(initial: number, keys: readonly Key[], t: number, spring: Required<SpringOpts> = PROP_SPRING): number {
  const rise = springRiseTime(spring);
  let from = initial;
  let prev: { start: number; from: number; to: number } | null = null;
  for (const k of keys) {
    const start = snapToFrame(k.at) - rise;
    if (prev) from = springValue(start, prev.start, prev.from, prev.to, spring);
    if (t < start) return prev ? springValue(t, prev.start, prev.from, prev.to, spring) : initial;
    prev = { start, from, to: k.value };
  }
  return prev ? springValue(t, prev.start, prev.from, prev.to, spring) : initial;
}

// ------------------------------------------------------------------ counter

/**
 * Odometer drum positions (in digit steps, 0..10) for a value, least significant digit last.
 * The ones drum rolls continuously; each higher drum sits still on its digit and only turns during the
 * last single step before it ticks over (e.g. 1999 -> 2000, when every lower drum is turning too), like a
 * real mechanical counter. Settled integers land every drum exactly on a digit.
 */
export function odometerPositions(value: number, digits: number): number[] {
  const out: number[] = [];
  for (let p = digits - 1; p >= 0; p--) {
    const unit = 10 ** p;
    if (p === 0) {
      out.push(((value % 10) + 10) % 10);
      continue;
    }
    const whole = Math.floor(value / unit);
    const lower = value - whole * unit; // progress through the drums below
    const carry = smoothstep(1 - 1 / unit, 1.0, lower / unit); // window is one ones-step wide at every place
    out.push((((whole + carry) % 10) + 10) % 10);
  }
  return out;
}

// -------------------------------------------------------------------- clock

export const parseClock = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return ((h! % 12) * 60 + m!) % 720;
};

/**
 * Unwrapped target minutes for a chain of clock events: each event whirls the hands FORWARD past
 * `whirls` full turns of the hour hand before settling on the new time.
 */
export function clockKeys(initial: string, events: readonly { at: number; time: string }[], whirls = 1): { start: number; keys: Key[] } {
  const start = parseClock(initial);
  let cur = start;
  const keys: Key[] = [];
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    const target = parseClock(e.time);
    const ahead = (((target - cur) % 720) + 720) % 720;
    cur += ahead + 720 * whirls;
    keys.push({ at: e.at, value: cur });
  }
  return { start, keys };
}

/** Hand angles in radians, clockwise from 12. */
export const clockAngles = (minutes: number): { hour: number; minute: number } => ({
  hour: (minutes / 720) * Math.PI * 2,
  minute: ((minutes % 60) / 60) * Math.PI * 2,
});

// ----------------------------------------------------------------- calendar

/** Which day the page shows, how far the top flap has folded (0..1), and the day revealed beneath it. */
export function calendarFlip(value: number): { current: number; next: number; fold: number } {
  const floor = Math.floor(value + 1e-9);
  const fold = clamp01(value - floor < 1e-9 ? 0 : value - floor);
  return { current: wrapDay(floor), next: wrapDay(floor + 1), fold };
}
const wrapDay = (d: number): number => ((((d - 1) % 31) + 31) % 31) + 1;

// ---------------------------------------------------------------- aggregate

export type PropState =
  | { kind: 'counter'; value: number }
  | { kind: 'dial'; value: number }
  | { kind: 'calendar'; value: number }
  | { kind: 'clock'; minutes: number }
  | { kind: 'magnifier'; x: number; y: number };

const eventsFor = (shot: Shot, id: string): PropEvent[] => shot.propEvents.filter((e) => e.prop === id).sort((a, b) => a.at - b.at);

/** State of one prop at timeline time `t`. Pure. */
export function propStateAt(shot: Shot, prop: PropDef, t: number): PropState {
  const ev = eventsFor(shot, prop.id);
  switch (prop.kind) {
    case 'counter':
    case 'dial':
    case 'calendar': {
      const keys = ev.flatMap((e) => (e.value === undefined ? [] : [{ at: e.at, value: e.value }]));
      return { kind: prop.kind, value: chainValue(prop.initial, keys, t) };
    }
    case 'clock': {
      const { start, keys } = clockKeys(prop.initial, ev.flatMap((e) => (e.time ? [{ at: e.at, time: e.time }] : [])));
      return { kind: 'clock', minutes: chainValue(start, keys, t) };
    }
    case 'magnifier': {
      const tos = ev.flatMap((e) => (e.to ? [{ at: e.at, to: e.to }] : []));
      return {
        kind: 'magnifier',
        x: chainValue(prop.initial[0], tos.map((e) => ({ at: e.at, value: e.to[0] })), t, LENS_SPRING),
        y: chainValue(prop.initial[1], tos.map((e) => ({ at: e.at, value: e.to[1] })), t, LENS_SPRING),
      };
    }
  }
}
