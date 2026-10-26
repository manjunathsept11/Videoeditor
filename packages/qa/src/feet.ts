import type { Shot } from '@shortstudio/schema';
import { reachProblems, walkPlans } from '@shortstudio/engine/pure';
import type { Issue } from './framing';

type Walk = Extract<Shot['events'][number], { type: 'walk' }>;

/** Same shot with one walk lasting `duration` seconds. */
const withWalkDuration = (shot: Shot, walk: Walk, duration: number): Shot => ({
  ...shot,
  events: shot.events.map((e) => (e === walk ? { ...e, until: e.at + duration } : e)),
});

/**
 * Shortest duration (to 0.05s) at which this walk keeps every planted foot within reach. The step count
 * rounds to whole steps, so feasibility is not monotonic in duration; require the next two candidates to
 * pass as well so the suggestion is safe to use.
 */
export function minimumWalkDuration(shot: Shot, walk: Walk): number | null {
  const ok = (d: number) => reachProblems(withWalkDuration(shot, walk, d)).every((p) => p.actor !== walk.actor || p.t < walk.at - 1e-9 || p.t > walk.at + d + 1e-9);
  for (let d = Math.max(0.4, walk.until - walk.at); d <= 12; d += 0.05) {
    if (ok(d) && ok(d + 0.05) && ok(d + 0.1)) return Math.round(d * 100) / 100;
  }
  return null;
}

/**
 * Foot sliding. The rig plants every stance foot at one world point (foot lock), so a foot can only slide
 * where the legs cannot span the stride and the solver would have to drag the foot. Report those walks, with
 * a duration that is known to fit.
 */
export function checkFootSliding(shot: Shot): Issue[] {
  const issues: Issue[] = [];
  const reported = new Set<string>();
  for (const p of reachProblems(shot)) {
    const actor = shot.actors.find((a) => a.id === p.actor)!;
    const plan = walkPlans(shot, actor).find((w) => p.t >= w.t0 - 1e-9 && p.t <= w.t1 + 1e-9);
    const walk = plan && shot.events.find((e): e is Walk => e.type === 'walk' && e.actor === p.actor && Math.abs(e.at - plan.t0) < 1e-9);
    const key = `${p.actor}|${plan?.t0}`;
    if (reported.has(key)) continue;
    reported.add(key);
    const need = walk ? minimumWalkDuration(shot, walk) : null;
    issues.push({
      check: 'foot-slide', severity: 'error', shot: shot.id, actor: p.actor,
      message:
        `${p.actor}'s legs cannot span the stride at ${(p.t - shot.start).toFixed(2)}s (${(p.short * 100).toFixed(0)}cm short), so a planted foot would slide` +
        (plan
          ? `; this walk covers ${plan.dist.toFixed(1)} units in ${(plan.t1 - plan.t0).toFixed(2)}s: ` +
            (need ? `make it at least ${need.toFixed(2)}s long (a later "until" word), ` : '') +
            `shorten the distance, or use a larger actor scale`
          : ''),
    });
  }
  return issues;
}
