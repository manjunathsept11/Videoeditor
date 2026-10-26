import { describe, expect, it } from 'vitest';
import { parseBundle } from '@shortstudio/schema';
import { checkShot, fixShot } from '../src/fix';
import { runQualityGate } from '../src/gate';
import { segmentEntersBox } from '../src/solids';

const set = (objects: object[]) => ({ id: 's', background: '#000000', objects });
const wall = { kind: 'box', id: 'pillar', position: [0, 2, 5], size: [2, 4, 1], color: '#444444' };
const ground = { kind: 'floor', id: 'ground', size: [40, 40], color: '#222222', position: [0, 0, -6] };
const crate = { kind: 'box', id: 'crate', position: [0, 0.6, 0], size: [2, 1.2, 2], color: '#664422' };

const bundle = (objects: object[], camera: object, actors: object[]) =>
  parseBundle({
    project: { name: 't', sets: ['s'], shots: ['a'] },
    sets: [set(objects)],
    shots: [{ id: 'a', set: 's', start: 0, duration: 2, camera, actors }],
  });
const cam = { position: [0, 1.8, 10], target: [0, 1.6, 0], fov: 40 };
const actor = (id: string, p: number[]) => ({ id, bodyColor: '#ff8800', position: p });

describe('segmentEntersBox', () => {
  const box = { id: 'b', min: [-1, 0, -1] as const, max: [1, 2, 1] as const };
  it('finds the entry parameter, and misses cleanly', () => {
    expect(segmentEntersBox([0, 1, 5], [0, 1, -5], box)).toBeCloseTo(0.4, 9);
    expect(segmentEntersBox([5, 1, 5], [5, 1, -5], box)).toBeNull();
    expect(segmentEntersBox([0, 1, 5], [0, 1, 2], box)).toBeNull(); // stops short
  });
});

describe('object occlusion', () => {
  it('flags a pillar between camera and actor and fixes it by sliding the camera', () => {
    const b = bundle([ground, wall], cam, [actor('a', [0, 0, 0])]);
    const shot = b.shots.a!;
    const issues = checkShot(shot, b.sets.s!);
    expect(issues.map((i) => i.check)).toContain('object-occlusion');
    const r = fixShot(shot, b.sets.s!);
    expect(r.remaining.filter((i) => i.severity === 'error')).toEqual([]);
    expect(r.fixes.join(' ')).toMatch(/moved camera/);
    expect(r.patch.camera!.position[0]).not.toBe(0);
    expect(r.patch.camera!.target).toEqual([0, 1.6, 0]); // arcs around, keeps looking at the actors
  });
  it('does not flag a prop that is behind the actor', () => {
    const behind = { ...wall, position: [0, 2, -5] };
    const b = bundle([behind], cam, [actor('a', [0, 0, 0])]);
    expect(checkShot(b.shots.a!, b.sets.s!).map((i) => i.check)).not.toContain('object-occlusion');
  });
});

describe('prop clipping', () => {
  it('flags an actor inside a crate and walks them out', () => {
    const b = bundle([crate], cam, [actor('a', [0.2, 0, 0.3])]);
    expect(checkShot(b.shots.a!, b.sets.s!).map((i) => i.check)).toContain('prop-clipping');
    const r = fixShot(b.shots.a!, b.sets.s!);
    expect(r.remaining.filter((i) => i.check === 'prop-clipping')).toEqual([]);
    const [x, , z] = r.patch.actors!.a!;
    expect(Math.hypot(x - 0.2, z - 0.3)).toBeGreaterThan(0.5);
  });
  it('ignores props the actor merely stands near, and overhead signs', () => {
    const sign = { kind: 'sign', id: 'sg', position: [0, 3.5, 0], size: [2, 0.8], text: 'X', color: '#ff00ff' };
    const b = bundle([sign, { ...crate, position: [3, 0.6, 0] }], cam, [actor('a', [0, 0, 0])]);
    expect(checkShot(b.shots.a!, b.sets.s!).map((i) => i.check)).not.toContain('prop-clipping');
  });
});

describe('framing fix', () => {
  it('pulls the camera back so a cropped actor fits, and recentres on the cast', () => {
    const close = { position: [0, 1.8, 3], target: [0, 1.6, 0], fov: 40 };
    const b = bundle([ground], close, [actor('a', [-0.8, 0, 0]), actor('b', [0.8, 0, 0])]);
    expect(checkShot(b.shots.a!, b.sets.s!).some((i) => i.severity === 'error')).toBe(true);
    const r = fixShot(b.shots.a!, b.sets.s!);
    expect(r.remaining.filter((i) => i.severity === 'error')).toEqual([]);
    expect(r.patch.camera!.position[2]).toBeGreaterThan(3);
  });
  it('leaves a good shot untouched', () => {
    const b = bundle([], cam, [actor('a', [0, 0, 0])]);
    const r = fixShot(b.shots.a!, b.sets.s!);
    expect(r.fixes).toEqual([]);
    expect(r.patch).toEqual({});
  });
});

describe('runQualityGate', () => {
  it('reports failures without fixing, then passes after fix', () => {
    const b = bundle([ground, wall, crate], cam, [actor('a', [0, 0, 0])]);
    const before = runQualityGate(b);
    expect(before.passed).toBe(false);
    expect(before.issues.map((i) => i.check)).toEqual(expect.arrayContaining(['object-occlusion', 'prop-clipping']));
    const after = runQualityGate(b, { fix: true });
    expect(after.passed).toBe(true);
    expect(Object.keys(after.patches)).toEqual(['a']);
  });
});

describe('floor coverage', () => {
  const shortFloor = { kind: 'floor', id: 'f', size: [30, 14], color: '#222222', position: [0, 0, -3] }; // spans z=-10..+4
  const bigFloor = { kind: 'floor', id: 'f', size: [40, 40], color: '#222222', position: [0, 0, -6] };
  it('flags a floor that stops short of the camera', () => {
    const b = bundle([shortFloor], cam, [actor('a', [0, 0, 0])]);
    const issues = checkShot(b.shots.a!, b.sets.s!);
    expect(issues.map((i) => i.check)).toContain('floor-gap');
    expect(issues.find((i) => i.check === 'floor-gap')!.message).toMatch(/extend the floor/);
  });
  it('passes when the floor reaches under the whole frame', () => {
    const b = bundle([bigFloor], cam, [actor('a', [0, 0, 0])]);
    expect(checkShot(b.shots.a!, b.sets.s!).map((i) => i.check)).not.toContain('floor-gap');
  });
  it('ignores shots whose bottom edge looks above the horizon', () => {
    const up = { position: [0, 1.8, 10], target: [0, 8, 0], fov: 30 };
    const b = bundle([shortFloor], up, [actor('a', [0, 0, 0])]);
    expect(checkShot(b.shots.a!, b.sets.s!).map((i) => i.check)).not.toContain('floor-gap');
  });
});

describe('floor repair at set level', () => {
  const shortFloor = { kind: 'floor', id: 'f', size: [30, 14], color: '#222222', position: [0, 0, -3] };
  it('gate --fix widens the floor, and the shot then passes', () => {
    const b = bundle([shortFloor], cam, [actor('a', [0, 0, 0])]);
    expect(runQualityGate(b).passed).toBe(false);
    const r = runQualityGate(b, { fix: true });
    expect(r.passed).toBe(true);
    expect(r.fixes['set:s']![0]).toMatch(/extended the floor/);
    const floor = r.setPatches.s!.objects.find((o) => o.kind === 'floor') as { size: number[]; position: number[] };
    expect(floor.size[1]).toBeGreaterThan(14);
    expect(floor.size[0]).toBeGreaterThanOrEqual(30); // never shrinks
  });
  it('adds a floor when the set has none', () => {
    const b = bundle([], cam, [actor('a', [0, 0, 0])]);
    const r = runQualityGate(b, { fix: true });
    expect(r.passed).toBe(true);
    expect(r.setPatches.s!.objects.some((o) => o.kind === 'floor')).toBe(true);
  });
  it('is a no-op when the floor already covers everything', () => {
    const b = bundle([ground], cam, [actor('a', [0, 0, 0])]);
    expect(runQualityGate(b, { fix: true }).setPatches).toEqual({});
  });
});

describe('props in frame', () => {
  const withProps = (props: object[]) =>
    parseBundle({
      project: { name: 't', sets: ['s'], shots: ['a'] },
      sets: [set([ground])],
      shots: [{ id: 'a', set: 's', start: 0, duration: 2, camera: cam, actors: [actor('a', [0, 0, 0])], props }],
    });
  const counter = (extra: object = {}) => ({ kind: 'counter', id: 'c', position: [0, 4.0, 0], digits: 4, ...extra });
  it('passes a prop that fits above the actors, with room for the camera creep', () => {
    const b = withProps([{ ...counter(), digits: 2, scale: 0.8 }]);
    expect(checkShot(b.shots.a!, b.sets.s!).filter((i) => i.check.startsWith('prop-')).map((i) => i.check)).toEqual([]);
  });
  it('flags a counter wider than the frame', () => {
    const b = withProps([counter({ digits: 6, prefix: '¥', suffix: 'B' })]);
    expect(checkShot(b.shots.a!, b.sets.s!).map((i) => i.check)).toContain('prop-out-of-frame');
  });
  it('flags a prop pushed off the side', () => {
    const b = withProps([{ kind: 'dial', id: 'd', position: [3.2, 3, 0] }]);
    expect(checkShot(b.shots.a!, b.sets.s!).map((i) => i.check)).toContain('prop-out-of-frame');
  });
  it('flags a prop sitting in the caption zone', () => {
    const b = withProps([{ kind: 'clock', id: 'k', position: [0, 0.3, 0] }]);
    expect(checkShot(b.shots.a!, b.sets.s!).map((i) => i.check)).toContain('prop-under-caption');
  });
  it('scale matters: a too-wide counter fits when scaled down', () => {
    const wide = { digits: 6, prefix: '¥', suffix: 'B' }; // 4.6 units wide: more than the ~3.7 visible at this distance
    expect(checkShot(withProps([counter(wide)]).shots.a!, withProps([]).sets.s!).map((i) => i.check)).toContain('prop-out-of-frame');
    const b = withProps([counter({ ...wide, scale: 0.6 })]);
    expect(checkShot(b.shots.a!, b.sets.s!).map((i) => i.check)).not.toContain('prop-out-of-frame');
  });
});

describe('props in frame: camera creep', () => {
  it('a prop that fits at the start of a long shot is cut off by the end', () => {
    const mk = (duration: number) =>
      parseBundle({
        project: { name: 't', sets: ['s'], shots: ['a'] },
        sets: [set([ground])],
        shots: [{ id: 'a', set: 's', start: 0, duration, camera: cam, actors: [actor('a', [0, 0, 0])], props: [{ kind: 'dial', id: 'd', position: [0.9, 3.2, 0] }] }], // right edge 1.75: inside the ~2.0 half-width at the start, outside the ~1.5 at the end
      });
    const short = mk(0.1), long = mk(8);
    expect(checkShot(short.shots.a!, short.sets.s!).map((i) => i.check)).not.toContain('prop-out-of-frame');
    expect(checkShot(long.shots.a!, long.sets.s!).map((i) => i.check)).toContain('prop-out-of-frame');
  });
});
