import { effectiveSet, resolveAnchor, type Alignment, type SetDef, type Shot, type ShotSource, type TimeRef } from '@shortstudio/schema';
import { checkShot } from '@shortstudio/qa';

const seconds = (ref: TimeRef, alignment: Alignment): number | undefined => {
  if (typeof ref === 'number') return ref;
  const r = resolveAnchor(alignment, ref);
  return typeof r === 'number' ? r : undefined;
};

/**
 * The shot as the engine will see it, with every word anchor turned into seconds. Events whose anchors do not resolve
 * are left out (the anchor check reports them separately), so the geometric checks run on everything that can run.
 */
export function resolveForCheck(s: ShotSource, start: number, duration: number, alignment: Alignment): Shot {
  const events: Shot['events'] = [];
  for (const e of s.events) {
    const at = seconds(e.at, alignment);
    if (at === undefined) continue;
    if (e.type === 'walk') {
      const until = seconds(e.until, alignment);
      if (until !== undefined) events.push({ ...e, at, until });
    } else {
      events.push({ ...e, at });
    }
  }
  const propEvents: Shot['propEvents'] = [];
  for (const e of s.propEvents) {
    const at = seconds(e.at, alignment);
    if (at !== undefined) propEvents.push({ ...e, at });
  }
  return { ...s, start, duration, events, propEvents };
}

export interface ShotCheckContext {
  /** The shared set the shot uses (the shot's own overrides are applied on top). */
  set: SetDef;
  /** The shot's window on the project timeline, seconds. */
  start: number;
  end: number;
  alignment: Alignment;
  /**
   * Accept plain seconds as times. Only for projects with no voiceover alignment (so there are no words to anchor to);
   * agents building a project from a script always anchor to words.
   */
  allowSeconds?: boolean;
}

/**
 * Problems a model can fix in one shot: dangling actors, anchors that miss or fall outside the shot, bad prop
 * events, and every quality-gate error the shot can cause itself (framing, blocked views, props, walks, ...).
 */
export function checkShotSource(s: ShotSource, ctx: ShotCheckContext): string[] {
  const { alignment, start, end } = ctx;
  const issues: string[] = [];
  const ids = new Set(s.actors.map((a) => a.id));
  const inShot = (t: number) => t >= start - 0.05 && t < end + 0.05;
  const anchor = (where: string, ref: TimeRef, label: string): number | undefined => {
    if (typeof ref === 'number') {
      if (ctx.allowSeconds) return ref;
      issues.push(`${where}.${label} must be a word anchor, not seconds`);
      return undefined;
    }
    const t = resolveAnchor(alignment, ref);
    if (typeof t === 'string') {
      issues.push(`${where}.${label}: ${t}`);
      return undefined;
    }
    return t;
  };

  s.events.forEach((e, k) => {
    const where = `events[${k}]`;
    if (!ids.has(e.actor)) issues.push(`${where} targets unknown actor "${e.actor}"`);
    const t = anchor(where, e.at, 'at');
    if (t !== undefined && !inShot(t)) {
      issues.push(`${where} anchors "${typeof e.at === 'number' ? e.at : e.at.word}" at ${t.toFixed(2)}s, outside this shot (${start.toFixed(2)}-${end.toFixed(2)}s); pick a word inside it`);
    }
    if (e.type === 'walk') {
      const u = anchor(where, e.until, 'until');
      if (u !== undefined && t !== undefined && u <= t) issues.push(`${where} walk ends at ${u.toFixed(2)}s, not after it starts at ${t.toFixed(2)}s`);
    }
  });

  const propKinds = new Map(s.props.map((p) => [p.id, p.kind]));
  s.propEvents.forEach((e, k) => {
    const where = `propEvents[${k}]`;
    const kind = propKinds.get(e.prop);
    if (!kind) issues.push(`${where} targets unknown prop "${e.prop}"`);
    else {
      const need = kind === 'clock' ? 'time' : kind === 'magnifier' ? 'to' : 'value';
      if (e[need] === undefined) issues.push(`${where} for the ${kind} "${e.prop}" needs "${need}"`);
    }
    const t = anchor(where, e.at, 'at');
    if (t !== undefined && !inShot(t)) issues.push(`${where} anchors "${typeof e.at === 'number' ? e.at : e.at.word}" at ${t.toFixed(2)}s, outside this shot (${start.toFixed(2)}-${end.toFixed(2)}s)`);
  });

  // geometry on the shot as it will really play: walks, jolts and props included, against the shot's own set
  const resolved = resolveForCheck(s, start, Math.max(0.1, end - start), alignment);
  issues.push(
    ...checkShot(resolved, effectiveSet(ctx.set, s))
      // a floor gap is the set's problem; the pipeline repairs the set deterministically, a shot can't
      .filter((x) => x.severity === 'error' && x.check !== 'floor-gap')
      .map((x) => x.message),
  );
  return issues;
}
