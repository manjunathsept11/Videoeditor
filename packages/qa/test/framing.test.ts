import { describe, expect, it } from 'vitest';
import { parseBundle } from '@shortstudio/schema';
import { checkFraming } from '../src/framing';
import { cameraAt, project } from '../src/projection';

const shotWith = (camera: object, actors: object[], duration = 2) => {
  const b = parseBundle({
    project: { name: 't', sets: ['s'], shots: ['a'] },
    sets: [{ id: 's', background: '#000000', objects: [] }],
    shots: [{ id: 'a', set: 's', start: 0, duration, camera, actors }],
  });
  return b.shots.a!;
};
const actor = (id: string, position: number[]) => ({ id, bodyColor: '#ff8800', position });

describe('projection', () => {
  const cam = { position: [0, 1, 10] as const, target: [0, 1, 0] as const, fov: 40 };
  it('puts the target at the centre', () => {
    const p = project(cam, [0, 1, 0], 9 / 16)!;
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(0, 9);
    expect(p.depth).toBeCloseTo(10, 9);
  });
  it('matches the analytic frustum edge', () => {
    // half-height at distance 10 with fov 40 is 10*tan(20deg)
    const h = 10 * Math.tan((20 * Math.PI) / 180);
    expect(project(cam, [0, 1 + h, 0], 9 / 16)!.y).toBeCloseTo(1, 9);
    expect(project(cam, [h * (9 / 16), 1, 0], 9 / 16)!.x).toBeCloseTo(1, 9);
  });
  it('rejects points behind the camera', () => {
    expect(project(cam, [0, 1, 20], 9 / 16)).toBeNull();
  });
  it('creep moves the camera toward the target over time', () => {
    const c = { position: [0, 1, 10] as [number, number, number], target: [0, 1, 0] as [number, number, number], fov: 35, creep: 0.05 };
    expect(cameraAt(c, 0).position[2]).toBe(10);
    expect(cameraAt(c, 2).position[2]).toBeCloseTo(10 / 1.1, 9);
  });
});

describe('checkFraming', () => {
  const cam = { position: [0, 1.8, 10], target: [0, 1.8, 0], fov: 40 };
  it('passes a well framed pair', () => {
    expect(checkFraming(shotWith(cam, [actor('a', [-0.8, 0, 0]), actor('b', [0.8, 0, 0])]))).toEqual([]);
  });
  it('flags a head cropped at the frame edge', () => {
    const issues = checkFraming(shotWith(cam, [actor('a', [2.4, 0, 0])]));
    expect(issues.map((i) => i.check)).toContain('head-cropped');
  });
  it('flags a face under the caption zone', () => {
    const low = { position: [0, 1.8, 10], target: [0, 5, 0], fov: 40 }; // aimed high: actor lands low in frame
    expect(checkFraming(shotWith(low, [actor('a', [0, 0, 0])])).map((i) => i.check)).toContain('caption-occlusion');
  });
  it('flags an actor behind the camera', () => {
    expect(checkFraming(shotWith(cam, [actor('a', [0, 0, 12])])).map((i) => i.check)).toContain('behind-camera');
  });
  it('catches a head that only gets cropped late in the shot as the camera creeps in', () => {
    const tight = { position: [0, 1.8, 4.2], target: [0, 1.8, 0], fov: 40, creep: 0.5 };
    const early = checkFraming(shotWith(tight, [actor('a', [0, 0, 0])], 0.01));
    const late = checkFraming(shotWith(tight, [actor('a', [0, 0, 0])], 8));
    expect(early.filter((i) => i.check === 'head-cropped')).toHaveLength(0);
    expect(late.filter((i) => i.check === 'head-cropped')).toHaveLength(1);
  });
});

describe('scalp vs eyes', () => {
  it('allows a close-up that crops the scalp but keeps the eyes (warning only)', () => {
    // close in: the frame is ~0.31 wide at this distance, narrower than the 0.5-radius head but wider than the eye spread
    const cam = { position: [0, 1.3, 1.5], target: [0, 1.3, 0], fov: 40 };
    const issues = checkFraming(shotWith(cam, [actor('a', [0, 0, 0])], 0.01));
    expect(issues.some((i) => i.severity === 'error')).toBe(false);
    expect(issues.map((i) => i.check)).toContain('scalp-cropped');
  });
});
