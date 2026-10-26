import { describe, expect, it } from 'vitest';
import { Alignment, BundleError, parseBundle, resolveAnchor } from '../src/index';

const alignment = Alignment.parse({
  duration: 6,
  words: [
    { text: 'Japan', start: 0.0, end: 0.4 },
    { text: 'bans', start: 0.4, end: 0.8 },
    { text: 'gambling.', start: 0.8, end: 1.5 },
    { text: 'But', start: 1.9, end: 2.1 },
    { text: 'gambling', start: 2.1, end: 2.8 },
    { text: 'is', start: 2.8, end: 2.9 },
    { text: 'everywhere', start: 2.9, end: 3.6 },
  ],
});

const cam = { position: [0, 1, 6], target: [0, 1, 0] };
const base = (shots: unknown[]) => ({
  project: { name: 't', sets: ['s'], shots: shots.map((s) => (s as { id: string }).id) },
  sets: [{ id: 's', background: '#000000', objects: [] }],
  shots,
});

describe('resolveAnchor', () => {
  it('matches ignoring case and punctuation, nth occurrence, edges, offset', () => {
    expect(resolveAnchor(alignment, { word: 'GAMBLING', nth: 1, edge: 'start', offset: 0 })).toBe(0.8);
    expect(resolveAnchor(alignment, { word: 'gambling', nth: 2, edge: 'start', offset: 0 })).toBe(2.1);
    expect(resolveAnchor(alignment, { word: 'gambling', nth: 2, edge: 'end', offset: 0 })).toBe(2.8);
    expect(resolveAnchor(alignment, { word: 'bans', nth: 1, edge: 'start', offset: 0.05 })).toBeCloseTo(0.45, 9);
  });
  it('matches multi-word phrases', () => {
    expect(resolveAnchor(alignment, { word: 'is everywhere', nth: 1, edge: 'end', offset: 0 })).toBe(3.6);
  });
  it('explains failures', () => {
    expect(resolveAnchor(alignment, { word: 'pachinko', nth: 1, edge: 'start', offset: 0 })).toMatch(/not found/);
    expect(resolveAnchor(alignment, { word: 'gambling', nth: 3, edge: 'start', offset: 0 })).toMatch(/occurs 2 time/);
  });
});

describe('Alignment schema', () => {
  it('rejects words that go backwards', () => {
    expect(Alignment.safeParse({ words: [{ text: 'a', start: 1, end: 2 }, { text: 'b', start: 0.5, end: 0.9 }] }).success).toBe(false);
    expect(Alignment.safeParse({ words: [{ text: 'a', start: 1, end: 0.5 }] }).success).toBe(false);
  });
});

describe('parseBundle with anchors', () => {
  const shots = () => [
    { id: 'a', set: 's', start: 0, camera: cam, actors: [{ id: 'bob', bodyColor: '#ff8800', position: [0, 0, 0] }],
      events: [{ type: 'gesture', actor: 'bob', at: { word: 'gambling' }, gesture: 'raise' }] },
    { id: 'b', set: 's', start: { word: 'But' }, camera: cam, transitionIn: { type: 'dissolve' },
      actors: [{ id: 'bob', bodyColor: '#ff8800', position: [0, 0, 0] }],
      events: [{ type: 'expression', actor: 'bob', at: { word: 'gambling', nth: 2 }, expression: 'panic' }] },
  ];

  it('resolves starts, event times and implicit durations', () => {
    const b = parseBundle(base(shots()), { alignment });
    expect(b.shots.a!.start).toBe(0);
    expect(b.shots.a!.duration).toBeCloseTo(1.9, 9);            // runs to the next shot
    expect(b.shots.a!.events[0]!.at).toBe(0.8);
    expect(b.shots.b!.start).toBe(1.9);
    expect(b.shots.b!.duration).toBeCloseTo(6 - 1.9, 9);        // last shot runs to audio end
    expect(b.shots.b!.events[0]!.at).toBe(2.1);
  });

  it('fails clearly when anchors have no alignment', () => {
    expect(() => parseBundle(base(shots()))).toThrow(/no alignment was provided/);
  });

  it('reports unknown words and a missing last duration together', () => {
    const s = shots();
    (s[0] as any).events[0].at.word = 'pachinko';
    const noDur = Alignment.parse({ words: alignment.words });
    try { parseBundle(base(s), { alignment: noDur }); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(BundleError);
      const m = (e as BundleError).issues.join('\n');
      expect(m).toMatch(/"pachinko" not found/);
      expect(m).toMatch(/last shot needs a duration/);
    }
  });

  it('rejects shots that start out of order', () => {
    const s = shots();
    (s[1] as any).start = 0;
    expect(() => parseBundle(base(s), { alignment })).toThrow(/non-positive duration/);
  });
});

describe('per-shot set overrides', () => {
  const cam2 = { position: [0, 1.8, 10], target: [0, 1.6, 0], fov: 40 };
  const base = (overrides: object) => ({
    project: { name: 't', sets: ['s'], shots: ['a', 'b'] },
    sets: [{ id: 's', background: '#000000', objects: [
      { kind: 'floor', id: 'ground', size: [40, 40], color: '#222222' },
      { kind: 'sign', id: 'sign', position: [0, 3, -4], size: [3, 1], text: 'OLD', color: '#ff00ff' },
      { kind: 'box', id: 'crate', position: [2, 0.5, -3], size: [1, 1, 1], color: '#664422' },
    ] }],
    shots: [
      { id: 'a', set: 's', start: 0, duration: 2, camera: cam2, setOverrides: overrides },
      { id: 'b', set: 's', start: 2, duration: 2, camera: cam2 },
    ],
  });

  it('replaces, adds and removes objects for one shot only', async () => {
    const { effectiveSet } = await import('../src/index');
    const b = parseBundle(base({
      remove: ['crate'],
      objects: [
        { kind: 'sign', id: 'sign', position: [1, 3, -4], size: [3, 1], text: 'NEW', color: '#00ffff' },
        { kind: 'lantern', id: 'extra', position: [0, 4, -3] },
      ],
    }));
    const a = effectiveSet(b.sets.s!, b.shots.a!);
    expect(a.objects.map((o) => o.id)).toEqual(['ground', 'sign', 'extra']);
    expect((a.objects.find((o) => o.id === 'sign') as { text: string }).text).toBe('NEW');
    // the shared set and the other shot are untouched
    expect(b.sets.s!.objects.map((o) => o.id)).toEqual(['ground', 'sign', 'crate']);
    expect(effectiveSet(b.sets.s!, b.shots.b!)).toBe(b.sets.s);
  });
  it('does not resurrect a removed object that an override also lists', async () => {
    const { effectiveSet } = await import('../src/index');
    const b = parseBundle(base({ remove: ['crate'], objects: [{ kind: 'box', id: 'crate', position: [0, 0.5, 0], size: [1, 1, 1], color: '#ffffff' }] }));
    expect(effectiveSet(b.sets.s!, b.shots.a!).objects.map((o) => o.id)).not.toContain('crate');
  });
  it('rejects removing an object the set does not have', () => {
    expect(() => parseBundle(base({ remove: ['ghost'] }))).toThrow(/"ghost", which is not an object of set "s"/);
  });
});
