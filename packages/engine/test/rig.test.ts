import { describe, expect, it } from 'vitest';
import { parseBundle, type Shot } from '@shortstudio/schema';
import {
  BOB, FOOT_LIFT, HEAD_HEIGHT, HIP_IDLE, HIP_SPREAD, LEG_LENGTH, STEP_FRAMES, hipWorld, joltOffset, planWalk, reachProblems, rigAt,
  twoBoneKnee, walkPlans,
} from '../src/rig';
import { actorPoseAt } from '../src/pose';
import { FRAME } from '../src/rules';

const cam = { position: [0, 1.8, 10], target: [0, 1.6, 0], fov: 40 };
function shotWith(events: object[], actor: object = {}) {
  return parseBundle({
    project: { name: 't', sets: ['s'], shots: ['a'] },
    sets: [{ id: 's', background: '#000000', objects: [] }],
    shots: [{ id: 'a', set: 's', start: 0, duration: 10, camera: cam, actors: [{ id: 'ken', bodyColor: '#ff8800', position: [0, 0, 0], ...actor }], events }],
  }).shots.a!;
}
const walk = (at: number, until: number, to: [number, number], extra: object = {}) => ({ type: 'walk', actor: 'ken', at, until, to, ...extra });
const actorOf = (s: Shot) => s.actors[0]!;

describe('walk plan: cadence', () => {
  it('steps every 5-6 frames for walks of any sensible length', () => {
    for (const D of [1.0, 1.3, 1.7, 2.2, 3.1, 5.0]) {
      const s = shotWith([walk(1, 1 + D, [2, 1])]);
      const p = walkPlans(s, actorOf(s))[0]!;
      const frames = p.Ts / FRAME;
      expect(frames, `D=${D}`).toBeGreaterThanOrEqual(4.8);
      expect(frames, `D=${D}`).toBeLessThanOrEqual(6.4);
      expect(p.n * p.Ts).toBeCloseTo(D, 9);
    }
    expect(STEP_FRAMES).toBe(5.5);
  });
});

describe('foot lock: a planted foot never moves', () => {
  const s = shotWith([walk(1, 3.2, [1.8, 1.2])]);
  const a = actorOf(s);
  const plan = walkPlans(s, a)[0]!;

  it('every stance interval keeps its foot at exactly one world point', () => {
    for (let k = 0; k < plan.n; k++) {
      const seen: string[] = [];
      for (let u = 0; u < 0.999; u += 1 / 60) {
        const t = plan.t0 + (k + u) * plan.Ts;
        const f = rigAt(s, a, t).feet!;
        const planted = k % 2 === 0 ? f.right : f.left;
        expect(planted[1]).toBeCloseTo(0, 9); // on the floor (float noise at the step boundary aside)
        seen.push(planted.map((v) => v.toFixed(9)).join(','));
      }
      expect(new Set(seen).size, `step ${k}`).toBe(1);
    }
  });

  it('the swing foot leaves one landing point and arrives exactly at the next, lifting in between', () => {
    const k = 3;
    const swing = (u: number) => {
      const f = rigAt(s, a, plan.t0 + (k + u) * plan.Ts).feet!;
      return k % 2 === 0 ? f.left : f.right;
    };
    const P = (i: number) => plan.landings[i + 1]!;
    expect(swing(0)[0]).toBeCloseTo(P(k - 1)[0], 9);
    expect(swing(0)[2]).toBeCloseTo(P(k - 1)[1], 9);
    expect(swing(0.9999)[0]).toBeCloseTo(P(k + 1)[0], 3);
    expect(swing(0.5)[1]).toBeCloseTo(FOOT_LIFT, 6);
  });

  it('a planted foot stays reachable for the whole walk (so the lock can hold)', () => {
    expect(reachProblems(s)).toEqual([]);
  });
});

describe('walk: seamless start and finish', () => {
  const s = shotWith([walk(1, 3, [2, 1.5])], { facingY: 0.3 });
  const a = actorOf(s);
  const idleFoot = (side: -1 | 1, yaw: number, at: [number, number]): [number, number] => [at[0] + side * HIP_SPREAD * Math.cos(yaw), at[1] - side * HIP_SPREAD * Math.sin(yaw)];

  it('feet are exactly where the idle stance has them at the first frame and after arriving', () => {
    const start = rigAt(s, a, 1);
    expect(start.feet!.right[0]).toBeCloseTo(idleFoot(-1, 0.3, [0, 0])[0], 9);
    expect(start.feet!.right[2]).toBeCloseTo(idleFoot(-1, 0.3, [0, 0])[1], 9);
    expect(start.feet!.left[0]).toBeCloseTo(idleFoot(1, 0.3, [0, 0])[0], 9);

    const end = rigAt(s, a, 3);
    const n = walkPlans(s, a)[0]!.n;
    const [planted, other] = (n - 1) % 2 === 0 ? [end.feet!.right, end.feet!.left] : [end.feet!.left, end.feet!.right];
    const sides = (n - 1) % 2 === 0 ? [-1, 1] : [1, -1];
    expect(planted[0]).toBeCloseTo(idleFoot(sides[0] as -1 | 1, 0.3, [2, 1.5])[0], 6);
    expect(other[0]).toBeCloseTo(idleFoot(sides[1] as -1 | 1, 0.3, [2, 1.5])[0], 3);
  });

  it('the actor arrives exactly on the destination, at idle height, facing the original way', () => {
    const done = rigAt(s, a, 3 + 10 * FRAME);
    expect(done.root[0]).toBeCloseTo(2, 9);
    expect(done.root[2]).toBeCloseTo(1.5, 9);
    expect(done.hipY).toBeCloseTo(HIP_IDLE, 9);
    expect(done.yaw).toBeCloseTo(0.3, 6);
    expect(done.feet).toBeNull();
    expect(done.walking).toBe(false);
  });

  it('the actor is exactly still before the walk', () => {
    expect(rigAt(s, a, 0)).toEqual(rigAt(s, a, 0.9));
  });

  it('faces the direction of travel mid-walk, or keeps facing when turn is false', () => {
    const heading = Math.atan2(2, 1.5);
    expect(rigAt(s, a, 2).yaw).toBeCloseTo(heading, 6);
    const strafe = shotWith([walk(1, 3, [2, 1.5], { turn: false })], { facingY: 0.3 });
    expect(rigAt(strafe, actorOf(strafe), 2).yaw).toBeCloseTo(0.3, 9);
  });
});

describe('walk: motion quality', () => {
  const s = shotWith([walk(1, 4, [3, 0])]);
  const a = actorOf(s);
  const frames = (from: number, to: number) => Array.from({ length: Math.round((to - from) / FRAME) + 1 }, (_, i) => from + i * FRAME);

  it('hip bob is 7% of head height, peak to peak, in the cruise', () => {
    const hips = frames(2, 3).map((t) => rigAt(s, a, t).hipY);
    const pp = Math.max(...hips) - Math.min(...hips);
    expect(pp).toBeGreaterThan(BOB * 0.8); // sampled at 30fps, so the true peak can fall between frames
    expect(pp).toBeLessThan(BOB * 1.01);
    expect(BOB).toBeCloseTo(0.07 * HEAD_HEIGHT, 12);
  });

  it('the hips never snap between frames (root, height and swing foot all move smoothly)', () => {
    let prev = rigAt(s, a, 0.9);
    for (const t of frames(1, 4.2)) {
      const r = rigAt(s, a, t);
      expect(Math.abs(r.hipY - prev.hipY), `hip @${t.toFixed(2)}`).toBeLessThan(0.05);
      expect(Math.hypot(r.root[0] - prev.root[0], r.root[2] - prev.root[2]), `root @${t.toFixed(2)}`).toBeLessThan(0.2);
      prev = r;
    }
  });

  it('arms swing opposite to each other and fade to nothing at the ends', () => {
    const mid = rigAt(s, a, 1 + 0.5 * 3 + 0.01);
    expect(mid.armSwing.left).toBeCloseTo(-mid.armSwing.right, 9);
    expect(rigAt(s, a, 1).armSwing.left).toBeCloseTo(0, 9);
    expect(rigAt(s, a, 4.2).armSwing.left).toBe(0);
  });

  it('the cruise speed is constant', () => {
    const sp = (t: number) => {
      const p = rigAt(s, a, t).root, q = rigAt(s, a, t + FRAME).root;
      return Math.hypot(q[0] - p[0], q[2] - p[2]) / FRAME;
    };
    expect(sp(2)).toBeCloseTo(sp(2.6), 6);
  });
});

describe('reach (what breaks foot lock)', () => {
  it('a brisk but sensible walk is fine, whichever way the actor turns', () => {
    for (const to of [[3, 0], [-3, 0], [0, 3], [0, -3], [2.1, 2.1], [-2, -2]] as [number, number][]) {
      expect(reachProblems(shotWith([walk(1, 3, to)])), `to ${to}`).toEqual([]);
      expect(reachProblems(shotWith([walk(1, 3, to)], { facingY: 0.7 })), `to ${to}, facing 0.7`).toEqual([]);
    }
  });
  it('strafing (turn: false) is fine too', () => {
    expect(reachProblems(shotWith([walk(1, 3, [3, 0], { turn: false })]))).toEqual([]);
  });
  it('an absurdly fast walk is reported with a time and how far short the legs fall', () => {
    const s = shotWith([walk(1, 2, [12, 0])]); // 12 units in a second
    const r = reachProblems(s);
    expect(r).toHaveLength(1);
    expect(r[0]!.actor).toBe('ken');
    expect(r[0]!.short).toBeGreaterThan(0.05);
    expect(r[0]!.t).toBeGreaterThanOrEqual(1);
  });
  it('scales with the actor: a bigger actor reaches further', () => {
    const fast = [walk(1, 2.5, [5.5, 0])];
    expect(reachProblems(shotWith(fast)).length).toBe(1);
    expect(reachProblems(shotWith(fast, { scale: 1.5 }))).toEqual([]);
  });
});

describe('chained walks', () => {
  it('the second walk starts where the first ended', () => {
    const s = shotWith([walk(1, 2.5, [2, 0]), walk(3, 4.5, [2, 3])]);
    const [p1, p2] = walkPlans(s, actorOf(s));
    expect(p1!.to).toEqual([2, 0]);
    expect(p2!.from).toEqual([2, 0]);
    expect(rigAt(s, actorOf(s), 5).root).toEqual([2, 0, 3]);
  });
});

describe('jolt', () => {
  it('rises 50% of head height within 2 frames, holds, and settles to the floor', () => {
    const A = 0.5 * HEAD_HEIGHT;
    expect(joltOffset(1 - 0.01, 1, 0.5)).toBe(0);
    expect(joltOffset(1 + 2 * FRAME, 1, 0.5)).toBeCloseTo(A, 9);
    expect(joltOffset(1 + 3 * FRAME, 1, 0.5)).toBeCloseTo(A, 9);
    expect(joltOffset(1 + 1 * FRAME, 1, 0.5)).toBeGreaterThan(A * 0.7); // most of the height in the first frame
    expect(joltOffset(1 + 7 * FRAME + 1e-9, 1, 0.5)).toBeCloseTo(0, 6);
    expect(joltOffset(5, 1, 0.5)).toBe(0);
  });
  it('lifts the whole body, lets the legs hang, and scales with the actor', () => {
    const s = shotWith([{ type: 'jolt', actor: 'ken', at: 1 }], { scale: 2 });
    const r = rigAt(s, actorOf(s), 1 + 2 * FRAME);
    expect(r.root[1]).toBeCloseTo(0.5 * HEAD_HEIGHT * 2, 9);
    expect(r.feet).toBeNull();
  });
  it('a jolt while standing leaves everything else still', () => {
    const s = shotWith([{ type: 'jolt', actor: 'ken', at: 1 }]);
    const a = rigAt(s, actorOf(s), 1 + 3 * FRAME);
    expect(a.root[0]).toBe(0);
    expect(a.root[2]).toBe(0);
    expect(a.yaw).toBe(0);
  });
});

describe('two-bone IK', () => {
  const l = 0.29;
  const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
  it('puts the knee exactly one segment from the hip and one from the foot', () => {
    const hip: [number, number, number] = [0, 0.5, 0];
    for (const foot of [[0, 0, 0], [0.2, 0, 0.15], [-0.3, 0.05, -0.1], [0.1, 0.12, 0.3]] as [number, number, number][]) {
      const k = twoBoneKnee(hip, foot, l, l, [0, 0, 1]);
      expect(k.overstretched).toBe(false);
      expect(dist(hip, k.knee)).toBeCloseTo(l, 9);
      expect(dist(k.knee, foot)).toBeCloseTo(l, 9);
    }
  });
  it('bends the knee toward the pole (forward)', () => {
    const k = twoBoneKnee([0, 0.5, 0], [0, 0.05, 0], l, l, [0, 0, 1]);
    expect(k.knee[2]).toBeGreaterThan(0.1);
  });
  it('reports an out-of-reach target and straightens the leg toward it', () => {
    const k = twoBoneKnee([0, 0.5, 0], [0, -0.3, 0], l, l, [0, 0, 1]);
    expect(k.overstretched).toBe(true);
    expect(dist([0, 0.5, 0], k.knee)).toBeCloseTo(l, 6);
  });
  it('idle stance is a straight leg that just reaches the floor', () => {
    expect(LEG_LENGTH).toBeCloseTo(HIP_IDLE, 12);
    const k = twoBoneKnee([0, HIP_IDLE, 0], [0, 0, 0], l, l, [0, 0, 1]);
    expect(k.overstretched).toBe(false);
    expect(Math.abs(k.knee[2])).toBeLessThan(1e-3);
  });
});

describe('hipWorld and pose', () => {
  it('hips sit HIP_SPREAD either side of the root, rotated with the actor', () => {
    const s = shotWith([], { facingY: Math.PI / 2 });
    const r = rigAt(s, actorOf(s), 0);
    const left = hipWorld(r, 1, 1);
    expect(left[0]).toBeCloseTo(0, 9);
    expect(left[2]).toBeCloseTo(-HIP_SPREAD, 9);
    expect(left[1]).toBeCloseTo(HIP_IDLE, 9);
  });
  it('actorPoseAt carries the rig, and idle actors are dead still', () => {
    const s = shotWith([]);
    expect(actorPoseAt(s, 'ken', 0)).toEqual(actorPoseAt(s, 'ken', 7.3));
    expect(planWalk([0, 0], 0, { type: 'walk', actor: 'ken', at: 0, until: 1, to: [0, 0], turn: true }).dist).toBe(0);
  });
});
