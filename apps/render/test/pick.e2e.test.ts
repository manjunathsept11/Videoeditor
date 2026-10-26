/** Click-to-edit's foundation, against the real renderer: project a known object to the screen, click there, see what is hit. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { effectiveSet } from '@shortstudio/schema';
import { cameraAt, project } from '@shortstudio/qa';
import { rigAt } from '@shortstudio/engine/pure';
import { loadProject } from '../project';
import { openStudio, type StudioSession } from '../session';

const root = resolve(__dirname, '../../..');
const W = 270, H = 480;

async function session(dir: string) {
  const { bundle } = loadProject(resolve(root, dir));
  return { bundle, s: await openStudio(bundle, W, H) };
}

/** NDC of a world point at timeline time t in the shot that is on screen. */
function ndc(bundle: ReturnType<typeof loadProject>['bundle'], shotId: string, t: number, p: [number, number, number]) {
  const shot = bundle.shots[shotId]!;
  const r = project(cameraAt(shot.camera, t - shot.start), p, W / H)!;
  return [r.x, r.y] as const;
}

describe('picking: props, actors and set objects', () => {
  let s: StudioSession;
  let bundle: ReturnType<typeof loadProject>['bundle'];
  beforeAll(async () => ({ s, bundle } = await session('examples/props')), 120_000);
  afterAll(() => s?.close());

  const pick = (t: number, x: number, y: number) => s.page.evaluate(([a, b, c]) => window.studioApi.pick(a as number, b as number, c as number), [t, x, y] as const);

  it('a click on a prop returns that prop and its shot', async () => {
    const [x, y] = ndc(bundle, 'shot_01', 0.5, [0, 4.6, 0.3]); // the counter, in front of its housing
    expect(await pick(0.5, x, y)).toMatchObject({ kind: 'prop', id: 'yen', shotId: 'shot_01' });
  });
  it('a click on a character returns the actor', async () => {
    const shot = bundle.shots.shot_01!;
    const ken = shot.actors.find((a) => a.id === 'ken')!;
    const root = rigAt(shot, ken, 0.5).root;
    const [x, y] = ndc(bundle, 'shot_01', 0.5, [root[0], 1.58, root[2] + 0.45]); // front of the head
    expect(await pick(0.5, x, y)).toMatchObject({ kind: 'actor', id: 'ken' });
  });
  it('a click on the sign returns that set object, not the glow around it', async () => {
    const sign = bundle.sets.neon_street!.objects.find((o) => o.id === 'sign_pachinko')!;
    const [px, py, pz] = (sign as { position: [number, number, number] }).position;
    const [x, y] = ndc(bundle, 'shot_01', 0.5, [px, py, pz]);
    const r = await pick(0.5, x, y);
    expect(r).toMatchObject({ kind: 'set', id: 'sign_pachinko' });
  });
  it('a click on bare floor returns the floor', async () => {
    const [x, y] = ndc(bundle, 'shot_01', 0.5, [3, 0, 5]);
    expect(await pick(0.5, x, y)).toMatchObject({ kind: 'set', id: 'road' });
  });
  it('a click on nothing at all returns null (an empty set has no walls or sky objects to hit)', async () => {
    const empty = structuredClone(bundle);
    empty.sets.neon_street!.objects = [];
    const e = await openStudio(empty, W, H);
    try {
      expect(await e.page.evaluate(() => window.studioApi.pick(0.5, 0.97, -0.97))).toBeNull();
      expect(await e.page.evaluate(() => window.studioApi.pick(0.5, 0, 0.6))).toMatchObject({ kind: 'prop', id: 'yen' }); // the prop is still there
    } finally {
      await e.close();
    }
  });
  it('picks the shot that is on screen at that time', async () => {
    const [x, y] = ndc(bundle, 'shot_02', 3.0, [0, 4.5, 0.3]); // shot_02's dial
    expect(await pick(3.0, x, y)).toMatchObject({ kind: 'prop', id: 'gauge', shotId: 'shot_02' });
  });
});

describe('selection box and hot reload', () => {
  let s: StudioSession;
  let bundle: ReturnType<typeof loadProject>['bundle'];
  beforeAll(async () => ({ s, bundle } = await session('examples/props')), 120_000);
  afterAll(() => s?.close());

  const frame = (t: number) => s.page.evaluate((tt) => window.studioApi.renderAt(tt, 'image/png'), t);

  it('highlighting changes the picture and clearing it restores it exactly', async () => {
    const plain = await frame(0.5);
    await s.page.evaluate(() => window.studioApi.highlight({ shotId: 'shot_01', kind: 'prop', id: 'yen' }));
    const lit = await frame(0.5);
    expect(lit).not.toBe(plain);
    await s.page.evaluate(() => window.studioApi.highlight(null));
    expect(await frame(0.5)).toBe(plain);
  });

  it('updateBundle rebuilds only the edited shot and the new content shows up', async () => {
    const before = await frame(0.5);
    const edited = structuredClone(bundle);
    edited.shots.shot_01!.props[0] = { ...edited.shots.shot_01!.props[0]!, prefix: '$' } as never;
    await s.page.evaluate(([b]) => window.studioApi.updateBundle(b as never, ['shot_01']), [edited] as const);
    expect(await frame(0.5)).not.toBe(before);
    // the other shot is unaffected by the reload
    const other = await frame(3.0);
    await s.page.evaluate(([b]) => window.studioApi.updateBundle(b as never, ['shot_01']), [edited] as const);
    expect(await frame(3.0)).toBe(other);
  });

  it('set overrides take effect in the shot that has them and nowhere else', async () => {
    const edited = structuredClone(bundle);
    // the shot's own sign text changes; the shared set is untouched
    const sign = bundle.sets.neon_street!.objects.find((o) => o.id === 'sign_pachinko')!;
    edited.shots.shot_01!.setOverrides = { remove: [], objects: [{ ...(sign as object), text: 'CAT' } as never] };
    const base = await frame(0.5);
    await s.page.evaluate(([b]) => window.studioApi.updateBundle(b as never, ['shot_01']), [edited] as const);
    expect(await frame(0.5)).not.toBe(base);
    expect(effectiveSet(edited.sets.neon_street!, edited.shots.shot_02!)).toBe(edited.sets.neon_street);
  });
}, 120_000);
