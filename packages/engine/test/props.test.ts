import { describe, expect, it } from 'vitest';
import { parseBundle } from '@shortstudio/schema';
import { FRAME, springOvershoot, springRiseTime, springValue } from '../src/rules';
import {
  calendarFlip, chainValue, clockAngles, clockKeys, odometerPositions, parseClock, propStateAt, snapToFrame, PROP_SPRING,
} from '../src/propState';

describe('springRiseTime: first touch on the spoken frame', () => {
  it('the step response equals its target exactly at the rise time and overshoots afterwards', () => {
    const r = springRiseTime();
    expect(springValue(r, 0, 0, 100)).toBeCloseTo(100, 6);
    expect(springValue(r * 0.98, 0, 0, 100)).toBeLessThan(100);
    expect(springValue(r * 1.2, 0, 0, 100)).toBeGreaterThan(100);
  });
  it('overshoot peaks near 10%', () => {
    let peak = 0;
    for (let t = 0; t < 1; t += 0.001) peak = Math.max(peak, springValue(t, 0, 0, 1));
    expect(peak - 1).toBeCloseTo(springOvershoot(0.59), 3);
  });
});

describe('chainValue', () => {
  const keys = [{ at: 2, value: 100 }, { at: 4, value: 250 }];
  it('sits on the initial value until the first spring starts', () => {
    expect(chainValue(5, keys, 0)).toBe(5);
    expect(chainValue(5, keys, 2 - springRiseTime() - 0.01)).toBe(5);
  });
  it('hits each target exactly on its frame', () => {
    expect(chainValue(5, keys, 2)).toBeCloseTo(100, 6);
    expect(chainValue(5, keys, 4)).toBeCloseTo(250, 6);
  });
  it('overshoots after the hit and settles on the target', () => {
    // 50 frames stops before the second spring starts (~3.9s)
    const peak = Math.max(...Array.from({ length: 50 }, (_, i) => chainValue(5, keys, 2 + i * FRAME)));
    expect(peak).toBeGreaterThan(100 + (100 - 5) * 0.08);
    expect(peak).toBeLessThan(100 + (100 - 5) * 0.12);
    expect(chainValue(5, keys, 3.6)).toBeCloseTo(100, 2);
    expect(chainValue(5, keys, 10)).toBeCloseTo(250, 6);
  });
  it('snaps an off-grid word time onto a frame boundary', () => {
    const at = 1.2345;
    expect(chainValue(0, [{ at, value: 10 }], snapToFrame(at))).toBeCloseTo(10, 6);
    expect(snapToFrame(at) * 30).toBeCloseTo(Math.round(at * 30), 9);
  });
  it('is continuous when a second spring starts before the first settles', () => {
    const k = [{ at: 1, value: 100 }, { at: 1.15, value: 0 }];
    let jump = 0;
    let prev = chainValue(0, k, 0.5);
    for (let t = 0.5; t < 2; t += 0.001) {
      const v = chainValue(0, k, t);
      jump = Math.max(jump, Math.abs(v - prev));
      prev = v;
    }
    expect(jump).toBeLessThan(2); // no teleport at the hand-off (100 units of travel)
  });
  it('is a pure function of t', () => {
    expect(chainValue(1, keys, 2.37)).toBe(chainValue(1, keys, 2.37));
  });
});

describe('odometer', () => {
  it('settled integers put every drum exactly on a digit', () => {
    for (const v of [0, 7, 34, 1999, 3400]) {
      const want = String(v).padStart(4, '0').split('').map(Number);
      expect(odometerPositions(v, 4)).toEqual(want);
    }
  });
  it('ones roll continuously, higher drums only turn at the carry', () => {
    expect(odometerPositions(12.5, 3)[2]).toBeCloseTo(2.5, 9);
    expect(odometerPositions(12.5, 3)[1]).toBe(1); // tens drum still on 1
    expect(odometerPositions(19.97, 3)[1]).toBeGreaterThan(1.5); // mid-carry toward 2
    expect(odometerPositions(19.97, 3)[1]).toBeLessThan(2);
  });
  it('wraps overshoot past the last digit and below zero without going out of range', () => {
    for (const v of [-0.4, 9.9, 10000.7]) odometerPositions(v, 4).forEach((p) => { expect(p).toBeGreaterThanOrEqual(0); expect(p).toBeLessThan(10 + 1e-9); });
  });
});

describe('clock', () => {
  it('parses 12h time', () => {
    expect(parseClock('3:30')).toBe(210);
    expect(parseClock('12:00')).toBe(0);
    expect(parseClock('15:45')).toBe(225);
  });
  it('always whirls forward past a full turn and lands on the target time', () => {
    const { start, keys } = clockKeys('12:00', [{ at: 2, time: '3:00' }, { at: 4, time: '3:00' }]);
    expect(start).toBe(0);
    expect(keys[0]!.value).toBe(180 + 720);
    expect(keys[1]!.value).toBe(180 + 1440); // same time again still whirls
    expect(((keys[0]!.value % 720) + 720) % 720).toBe(180);
  });
  it('angles: 3:00 puts the hour hand at 90 degrees and the minute hand at 12', () => {
    const a = clockAngles(180);
    expect(a.hour).toBeCloseTo(Math.PI / 2, 9);
    expect(a.minute).toBeCloseTo(0, 9);
    expect(clockAngles(30).minute).toBeCloseTo(Math.PI, 9);
  });
});

describe('calendar flip', () => {
  it('shows the day and an unfolded flap when settled', () => {
    expect(calendarFlip(15)).toEqual({ current: 15, next: 16, fold: 0 });
  });
  it('folds the flap through the fraction and wraps the month', () => {
    expect(calendarFlip(15.25).fold).toBeCloseTo(0.25, 9);
    expect(calendarFlip(31.5)).toMatchObject({ current: 31, next: 1 });
  });
});

describe('propStateAt', () => {
  const cam = { position: [0, 1.8, 10], target: [0, 1.6, 0], fov: 40 };
  const bundle = parseBundle({
    project: { name: 't', sets: ['s'], shots: ['a'] },
    sets: [{ id: 's', background: '#000000', objects: [] }],
    shots: [{
      id: 'a', set: 's', start: 0, duration: 6, camera: cam,
      props: [
        { kind: 'counter', id: 'yen', position: [0, 3, 0], initial: 0 },
        { kind: 'clock', id: 'clk', position: [2, 3, 0], initial: '12:00' },
        { kind: 'magnifier', id: 'mag', position: [-2, 2, 0], initial: [-0.5, 0.5] },
      ],
      propEvents: [
        { prop: 'yen', at: 2, value: 3400 },
        { prop: 'clk', at: 3, time: '4:30' },
        { prop: 'mag', at: 4, to: [0.5, -0.5] },
      ],
    }],
  });
  const shot = bundle.shots.a!;
  const prop = (id: string) => shot.props.find((p) => p.id === id)!;

  it('counter reaches the number on the exact frame', () => {
    const s = propStateAt(shot, prop('yen'), 2);
    expect(s.kind === 'counter' && s.value).toBeCloseTo(3400, 4);
    expect((propStateAt(shot, prop('yen'), 1) as { value: number }).value).toBe(0);
  });
  it('clock settles on the right time of day', () => {
    const s = propStateAt(shot, prop('clk'), 6) as { minutes: number };
    expect(((s.minutes % 720) + 720) % 720).toBeCloseTo(270, 4);
    expect(s.minutes).toBeGreaterThan(720);
  });
  it('magnifier slides both axes onto the target', () => {
    const s = propStateAt(shot, prop('mag'), 6) as { x: number; y: number };
    expect(s.x).toBeCloseTo(0.5, 3);
    expect(s.y).toBeCloseTo(-0.5, 3);
  });
  it('the PROP_SPRING default is the 10%-overshoot spring', () => {
    expect(springOvershoot(PROP_SPRING.zeta)).toBeCloseTo(0.1, 1);
  });
});

describe('prop event validation', () => {
  const base = (props: object[], propEvents: object[]) => ({
    project: { name: 't', sets: ['s'], shots: ['a'] },
    sets: [{ id: 's', background: '#000000', objects: [] }],
    shots: [{ id: 'a', set: 's', start: 0, duration: 2, camera: { position: [0, 1, 6], target: [0, 1, 0] }, props, propEvents }],
  });
  it('rejects unknown props and missing payloads with readable errors', () => {
    expect(() => parseBundle(base([], [{ prop: 'ghost', at: 1, value: 3 }]))).toThrow(/unknown prop "ghost"/);
    expect(() => parseBundle(base([{ kind: 'clock', id: 'c', position: [0, 1, 0] }], [{ prop: 'c', at: 1, value: 3 }]))).toThrow(/needs "time"/);
    expect(() => parseBundle(base([{ kind: 'counter', id: 'c', position: [0, 1, 0] }], [{ prop: 'c', at: 1 }]))).toThrow(/needs "value"/);
  });
  it('resolves word anchors on prop events', () => {
    const raw = base([{ kind: 'counter', id: 'c', position: [0, 1, 0] }], [{ prop: 'c', at: { word: 'trillion' }, value: 34 }]);
    const al = { words: [{ text: 'three', start: 0.2, end: 0.5 }, { text: 'trillion', start: 0.5, end: 1.1 }] };
    const b = parseBundle(raw, { alignment: al as never });
    expect(b.shots.a!.propEvents[0]!.at).toBe(0.5);
  });
});
