import { describe, expect, it } from 'vitest';
import { parseBundle } from '@shortstudio/schema';
import { checkShot, fixShot } from '../src/fix';
import { runQualityGate } from '../src/gate';
import { segmentEntersBox, solidsOf } from '../src/solids';

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

describe('moving actors', () => {
  const moving = (events: object[], objects: object[] = [ground], duration = 6) =>
    parseBundle({
      project: { name: 't', sets: ['s'], shots: ['a'] },
      sets: [set(objects)],
      shots: [{ id: 'a', set: 's', start: 0, duration, camera: cam, actors: [actor('a', [0, 0, 0])], events }],
    });
  const walk = (at: number, until: number, to: number[]) => ({ type: 'walk', actor: 'a', at, until, to });

  it('flags an actor who walks out of the frame even though they start inside it', () => {
    const b = moving([walk(1, 4, [6, 0])]);
    const issues = checkShot(b.shots.a!, b.sets.s!);
    expect(issues.map((i) => i.check)).toContain('head-cropped');
    expect(issues.find((i) => i.check === 'head-cropped')!.message).toMatch(/at \d\.\d\ds/); // mid-walk, not at the start
  });
  it('passes a walk that stays in frame', () => {
    const b = moving([walk(1, 4, [0.8, 0.5])]);
    expect(checkShot(b.shots.a!, b.sets.s!).filter((i) => i.severity === 'error')).toEqual([]);
  });
  it('flags a walk through a prop, which the start position alone would never show', () => {
    const wall = { kind: 'box', id: 'crate', position: [1.5, 0.6, 0], size: [1, 1.2, 1], color: '#664422' };
    const b = moving([walk(1, 4, [3, 0])], [ground, wall]);
    const c = checkShot(b.shots.a!, b.sets.s!).find((i) => i.check === 'prop-clipping')!;
    expect(c.message).toMatch(/crate/);
  });
  it('reports a stride the legs cannot span, with a duration that fits', () => {
    const b = moving([walk(1, 2, [5, 0])]);
    const f = checkShot(b.shots.a!, b.sets.s!).find((i) => i.check === 'foot-slide')!;
    expect(f.severity).toBe('error');
    expect(f.message).toMatch(/planted foot would slide/);
    expect(f.message).toMatch(/at least \d+\.\d\ds long/);
  });
  it('the suggested duration actually fixes it', () => {
    const slow = moving([walk(1, 2, [5, 0])]);
    const need = Number(/at least (\d+\.\d\d)s long/.exec(checkShot(slow.shots.a!, slow.sets.s!).find((i) => i.check === 'foot-slide')!.message)![1]);
    for (const extra of [0, 0.05, 0.1]) {
      const fixed = moving([walk(1, 1 + need + extra, [5, 0])], [ground], 9);
      expect(checkShot(fixed.shots.a!, fixed.sets.s!).map((i) => i.check), `need ${need} + ${extra}`).not.toContain('foot-slide');
    }
  });
  it('a jolt that throws the head out of a tight frame is caught at the peak', () => {
    const tight = { position: [0, 1.4, 2.2], target: [0, 1.4, 0], fov: 40 }; // frame top at ~2.2: eyes at 1.75 fit, but 2.25 (after the jolt) does not
    const mk = (events: object[]) =>
      parseBundle({
        project: { name: 't', sets: ['s'], shots: ['a'] },
        sets: [set([ground])],
        shots: [{ id: 'a', set: 's', start: 0, duration: 0.5, camera: tight, actors: [actor('a', [0, 0, 0])], events }],
      });
    const still = mk([]);
    const jolted = mk([{ type: 'jolt', actor: 'a', at: 0.1 }]);
    expect(checkShot(still.shots.a!, still.sets.s!).filter((i) => i.severity === 'error')).toEqual([]);
    expect(checkShot(jolted.shots.a!, jolted.sets.s!).some((i) => i.check === 'head-cropped')).toBe(true);
  });
});

describe('set dressing: collision bounds and gate checks', () => {
  const kit = (objects: object[], actors: object[] = [actor('a', [0, 0, 0])]) =>
    parseBundle({
      project: { name: 't', sets: ['s'], shots: ['a'] },
      sets: [set([ground, ...objects])],
      shots: [{ id: 'a', set: 's', start: 0, duration: 2, camera: cam, actors }],
    });
  const solid = (o: object) => {
    const b = kit([o]);
    return solidsOf(b.sets.s!).find((x) => x.id === (o as { id: string }).id)!;
  };

  it('every kind has bounds where the mesh really is', () => {
    const p = solid({ kind: 'pachinko', id: 'p', position: [2, 0, -3] });
    expect(p.min[1]).toBeCloseTo(0, 9);
    expect(p.max[1]).toBeCloseTo(2.35, 9);
    expect((p.min[0] + p.max[0]) / 2).toBeCloseTo(2, 9);
    expect(solid({ kind: 'pachinko', id: 'p', position: [0, 0, 0], scale: 2 }).max[1]).toBeCloseTo(4.7, 9);
    expect(solid({ kind: 'shopcounter', id: 'c', position: [0, 0, 0], width: 6 }).max[0]).toBeCloseTo(3.1, 9);
    expect(solid({ kind: 'shelf', id: 'sh', position: [0, 0, 0], size: [2, 3] }).max[1]).toBeCloseTo(3, 9);
    expect(solid({ kind: 'vending', id: 'v', position: [0, 0, 0] }).max[1]).toBeCloseTo(1.8, 9);
    expect(solid({ kind: 'streetlight', id: 'l', position: [0, 0, 0] }).max[1]).toBeCloseTo(4.4, 9);
    expect(solid({ kind: 'lantern', id: 'ln', position: [0, 5, 0] }).min[1]).toBeCloseTo(4.55, 9);
    const w = solid({ kind: 'exchangewindow', id: 'w', position: [0, 2, 0], size: [2.4, 1.5] });
    expect(w.max[1] - w.min[1]).toBeCloseTo(2.3, 9);
  });
  it('rotation widens the footprint', () => {
    const flat = solid({ kind: 'shopcounter', id: 'c', position: [0, 0, 0], width: 4 });
    const turned = solid({ kind: 'shopcounter', id: 'c', position: [0, 0, 0], width: 4, rotationY: Math.PI / 2 });
    expect(flat.max[0]).toBeGreaterThan(turned.max[0]);
    expect(turned.max[2]).toBeGreaterThan(flat.max[2]);
  });
  it('an actor inside a pachinko machine is flagged, and one beside it is not', () => {
    const p = { kind: 'pachinko', id: 'p', position: [0, 0, 0] };
    expect(checkShot(kit([p]).shots.a!, kit([p]).sets.s!).map((i) => i.check)).toContain('prop-clipping');
    const beside = kit([{ ...p, position: [3, 0, 0] }]);
    expect(checkShot(beside.shots.a!, beside.sets.s!).map((i) => i.check)).not.toContain('prop-clipping');
  });
  it('a machine between the camera and an actor blocks the view', () => {
    const b = kit([{ kind: 'pachinko', id: 'p', position: [0, 0, 4] }]);
    expect(checkShot(b.shots.a!, b.sets.s!).map((i) => i.check)).toContain('object-occlusion');
  });
  it('a streetlight (a thin pole) does not clip an actor standing a step away', () => {
    const b = kit([{ kind: 'streetlight', id: 'l', position: [0.8, 0, 0] }]);
    expect(checkShot(b.shots.a!, b.sets.s!).map((i) => i.check)).not.toContain('prop-clipping');
  });
});

describe('look defaults', () => {
  it('bloom and depth of field are on by default, bloom above plain white', () => {
    const b = bundle([ground], cam, [actor('a', [0, 0, 0])]);
    expect(b.project.look.bloom).toMatchObject({ threshold: 1.1 });
    expect(b.project.look.dof).toMatchObject({ aperture: 0.0008 });
  });
  it('either can be switched off', () => {
    const b = parseBundle({
      project: { name: 't', sets: ['s'], shots: ['a'], look: { bloom: false, dof: false } },
      sets: [set([ground])],
      shots: [{ id: 'a', set: 's', start: 0, duration: 2, camera: cam }],
    });
    expect(b.project.look).toEqual({ bloom: false, dof: false });
  });
});
