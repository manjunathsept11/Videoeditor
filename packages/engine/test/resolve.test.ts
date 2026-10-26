import { describe, expect, it } from 'vitest';
import { parseBundle, BundleError } from '@shortstudio/schema';
import { resolveAt } from '../src/resolve';
import { actorPoseAt } from '../src/pose';
import { FRAME } from '../src/rules';

const cam = { position: [0, 1, 6], target: [0, 1, 0] };
const raw = () => ({
  project: { name: 't', sets: ['s'], shots: ['a', 'b'] },
  sets: [{ id: 's', background: '#000000', objects: [] }],
  shots: [
    { id: 'a', set: 's', start: 0, duration: 2, camera: cam, actors: [{ id: 'bob', bodyColor: '#ff8800', position: [0, 0, 0] }],
      events: [{ type: 'gesture', actor: 'bob', at: 1, gesture: 'raise' }] },
    { id: 'b', set: 's', start: 2, duration: 2, camera: cam, transitionIn: { type: 'dissolve' } },
  ],
});

describe('bundle validation', () => {
  it('applies defaults', () => {
    const b = parseBundle(raw());
    expect(b.project.fps).toBe(30);
    expect(b.shots.a!.camera.creep).toBe(0.05);
    expect(b.shots.b!.transitionIn.frames).toBe(6);
  });
  it('rejects dangling references with readable errors', () => {
    const r = raw();
    r.shots[0]!.set = 'nope';
    (r.shots[0]!.events![0] as { actor: string }).actor = 'ghost';
    expect(() => parseBundle(r)).toThrow(BundleError);
    try { parseBundle(r); } catch (e) {
      expect((e as BundleError).issues.join('\n')).toMatch(/unknown set "nope"/);
      expect((e as BundleError).issues.join('\n')).toMatch(/unknown actor "ghost"/);
    }
  });
});

describe('resolveAt', () => {
  const b = parseBundle(raw());
  it('single layer mid-shot', () => {
    expect(resolveAt(b, 1)).toEqual([{ shotId: 'a', localT: 1, alpha: 1 }]);
  });
  it('dissolve spans 6 frames centred on the cut, outgoing keeps running', () => {
    const l = resolveAt(b, 2);
    expect(l).toHaveLength(2);
    expect(l[0]).toMatchObject({ shotId: 'a', alpha: 1 });
    expect(l[1]!.shotId).toBe('b');
    expect(l[1]!.alpha).toBeCloseTo(0.5, 9);
    expect(resolveAt(b, 2 - 4 * FRAME)).toHaveLength(1);
    const after = resolveAt(b, 2 + 4 * FRAME);
    expect(after).toHaveLength(1);
    expect(after[0]!.shotId).toBe('b');
    expect(after[0]!.localT).toBeCloseTo(4 * FRAME, 9);
  });
  it('holds the last shot past the end', () => {
    expect(resolveAt(b, 99)[0]!.shotId).toBe('b');
  });
});

describe('actor idle is dead still', () => {
  const b = parseBundle(raw());
  it('constant pose far from any event', () => {
    const a = actorPoseAt(b.shots.a!, 'bob', 0.1);
    const c = actorPoseAt(b.shots.a!, 'bob', 0.5);
    expect(a).toEqual(c);
  });
});
