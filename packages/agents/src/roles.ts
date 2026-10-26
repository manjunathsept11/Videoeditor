import { z } from 'zod';
import {
  Alignment, Anchor, Color, Id, SetDef, ShotSource, normalizeToken, resolveAnchor,
  type SetDef as SetDefT, type ShotSource as ShotSourceT,
} from '@shortstudio/schema';
import { checkShot } from '@shortstudio/qa';
import { generateValidated } from './generate';
import { DIRECTOR_SYSTEM, SET_SYSTEM, SHOT_SYSTEM } from './prompts';
import type { LlmProvider } from './provider';

// ------------------------------------------------------------------ storyboard

export const Storyboard = z.object({
  title: z.string(),
  cast: z.array(z.object({ id: Id, bodyColor: Color, glasses: z.boolean().default(false), role: z.string().default('') })).min(1),
  sets: z.array(z.object({ id: Id, brief: z.string() })).min(1),
  shots: z
    .array(
      z.object({
        id: Id,
        set: Id,
        startWord: Anchor,
        summary: z.string(),
        actors: z.array(Id).min(1),
        transition: z.enum(['cut', 'dissolve']).default('cut'),
      }),
    )
    .min(1),
});
export type Storyboard = z.infer<typeof Storyboard>;

const wordList = (a: Alignment) => a.words.map((w) => `${w.text}@${w.start.toFixed(2)}`).join(' ');

export interface DirectInput {
  script: string;
  alignment: Alignment;
  /** Target seconds per shot; the reference style cuts about every 1.1s. */
  targetShotSeconds?: number;
}

export function checkStoryboard(sb: Storyboard, alignment: Alignment, targetShotSeconds: number): string[] {
  const issues: string[] = [];
  const dup = (ids: string[], what: string) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) issues.push(`duplicate ${what} id "${id}"`);
      seen.add(id);
    }
  };
  dup(sb.cast.map((c) => c.id), 'cast');
  dup(sb.sets.map((s) => s.id), 'set');
  dup(sb.shots.map((s) => s.id), 'shot');
  const sets = new Set(sb.sets.map((s) => s.id));
  const cast = new Set(sb.cast.map((c) => c.id));
  let prev = -1;
  sb.shots.forEach((s, i) => {
    if (!sets.has(s.set)) issues.push(`${s.id} uses unknown set "${s.set}"`);
    for (const a of s.actors) if (!cast.has(a)) issues.push(`${s.id} uses actor "${a}" who is not in the cast`);
    const t = resolveAnchor(alignment, s.startWord);
    if (typeof t === 'string') issues.push(`${s.id} startWord: ${t}`);
    else {
      if (t <= prev) issues.push(`${s.id} starts at ${t.toFixed(2)}s, not after the previous shot (${prev.toFixed(2)}s); startWords must be in increasing order`);
      prev = t;
    }
    if (s.id !== `shot_${String(i + 1).padStart(2, '0')}`) issues.push(`shot ${i + 1} must be named shot_${String(i + 1).padStart(2, '0')}, got "${s.id}"`);
  });
  const total = alignment.duration ?? alignment.words.at(-1)?.end ?? 0;
  const avg = total / sb.shots.length;
  if (avg > targetShotSeconds * 2.5) {
    issues.push(`only ${sb.shots.length} shots for ${total.toFixed(1)}s (average ${avg.toFixed(1)}s); the target is about ${targetShotSeconds}s per shot, so use roughly ${Math.round(total / targetShotSeconds)} shots`);
  }
  const unused = [...sets].filter((id) => !sb.shots.some((s) => s.set === id));
  if (unused.length) issues.push(`sets never used by any shot: ${unused.join(', ')}`);
  return issues;
}

export function direct(provider: LlmProvider, input: DirectInput): Promise<Storyboard> {
  const target = input.targetShotSeconds ?? 1.1;
  return generateValidated({
    provider,
    what: 'storyboard',
    system: DIRECTOR_SYSTEM,
    user: `Script:\n${input.script}\n\nWord timings (word@seconds), the only words you may anchor to:\n${wordList(input.alignment)}\n\nVoiceover length: ${(input.alignment.duration ?? input.alignment.words.at(-1)?.end ?? 0).toFixed(1)}s. Target about ${target}s per shot.`,
    schema: Storyboard,
    check: (sb) => checkStoryboard(sb, input.alignment, target),
  });
}

// ------------------------------------------------------------------------ sets

export interface DesignSetInput {
  id: string;
  brief: string;
}

export function designSet(provider: LlmProvider, input: DesignSetInput): Promise<SetDefT> {
  return generateValidated({
    provider,
    what: `set "${input.id}"`,
    system: SET_SYSTEM,
    user: `Set id: ${input.id}\nBrief: ${input.brief}`,
    schema: SetDef,
    check: (s) => {
      const issues: string[] = [];
      if (s.id !== input.id) issues.push(`set id must be exactly "${input.id}", got "${s.id}"`);
      const ids = s.objects.map((o) => o.id);
      const dups = ids.filter((id, i) => ids.indexOf(id) !== i);
      if (dups.length) issues.push(`duplicate object ids: ${[...new Set(dups)].join(', ')}`);
      if (s.objects.length < 8) issues.push(`only ${s.objects.length} objects; build a richer set (at least 10)`);
      if (!s.objects.some((o) => o.kind === 'floor')) issues.push('the set needs a floor');
      if (!s.objects.some((o) => o.kind === 'light')) issues.push('the set needs at least one point light');
      return issues;
    },
  });
}

// ----------------------------------------------------------------------- shots

export interface BuildShotInput {
  storyboard: Storyboard;
  shotIndex: number;
  set: SetDefT;
  alignment: Alignment;
}

/** Start and end (seconds) of storyboard shot i, from its anchors. */
export function shotWindow(sb: Storyboard, i: number, alignment: Alignment): [number, number] {
  const time = (k: number) => resolveAnchor(alignment, sb.shots[k]!.startWord) as number;
  const start = i === 0 ? 0 : time(i);
  const end = i + 1 < sb.shots.length ? time(i + 1) : (alignment.duration ?? alignment.words.at(-1)?.end ?? start + 1);
  return [start, end];
}

export function buildShot(provider: LlmProvider, input: BuildShotInput): Promise<ShotSourceT> {
  const { storyboard: sb, shotIndex: i, set, alignment } = input;
  const plan = sb.shots[i]!;
  const [start, end] = shotWindow(sb, i, alignment);
  const cast = sb.cast.filter((c) => plan.actors.includes(c.id));
  const inWindow = alignment.words.filter((w) => w.start >= start - 1e-6 && w.start < end);
  const setSummary = set.objects.map((o) => `${o.kind}:${o.id}@${'position' in o ? `[${o.position.join(',')}]` : ''}`).join(' ');

  return generateValidated({
    provider,
    what: `shot "${plan.id}"`,
    system: SHOT_SYSTEM,
    user:
      `Storyboard shot: ${JSON.stringify(plan)}\nCast for this shot: ${JSON.stringify(cast)}\n` +
      `Set "${set.id}" objects (so you can aim the camera at the right part): ${setSummary}\n` +
      `Shot runs ${start.toFixed(2)}s to ${end.toFixed(2)}s (${(end - start).toFixed(2)}s). Words inside it (anchor events only to these): ${inWindow.map((w) => w.text).join(' ') || '(none)'}`,
    schema: ShotSource,
    check: (s) => {
      const issues: string[] = [];
      if (s.id !== plan.id) issues.push(`id must be "${plan.id}"`);
      if (s.set !== plan.set) issues.push(`set must be "${plan.set}"`);
      const ids = new Set(s.actors.map((a) => a.id));
      for (const a of plan.actors) if (!ids.has(a)) issues.push(`actor "${a}" from the storyboard is missing`);
      for (const a of s.actors) if (!plan.actors.includes(a.id)) issues.push(`actor "${a.id}" is not in this shot's storyboard`);
      s.events.forEach((e, k) => {
        if (!ids.has(e.actor)) issues.push(`events[${k}] targets unknown actor "${e.actor}"`);
        if (typeof e.at === 'number') {
          issues.push(`events[${k}].at must be a word anchor, not seconds`);
          return;
        }
        const t = resolveAnchor(alignment, e.at);
        if (typeof t === 'string') issues.push(`events[${k}]: ${t}`);
        else if (t < start - 0.05 || t >= end + 0.05) {
          issues.push(`events[${k}] anchors "${e.at.word}" at ${t.toFixed(2)}s, outside this shot (${start.toFixed(2)}-${end.toFixed(2)}s); pick a word inside it`);
        }
      });
      const propIds = new Map(s.props.map((p) => [p.id, p.kind]));
      s.propEvents.forEach((e, k) => {
        const kind = propIds.get(e.prop);
        if (!kind) {
          issues.push(`propEvents[${k}] targets unknown prop "${e.prop}"`);
          return;
        }
        const need = kind === 'clock' ? 'time' : kind === 'magnifier' ? 'to' : 'value';
        if (e[need] === undefined) issues.push(`propEvents[${k}] for the ${kind} "${e.prop}" needs "${need}"`);
        if (typeof e.at === 'number') {
          issues.push(`propEvents[${k}].at must be a word anchor, not seconds`);
          return;
        }
        const t = resolveAnchor(alignment, e.at);
        if (typeof t === 'string') issues.push(`propEvents[${k}]: ${t}`);
        else if (t < start - 0.05 || t >= end + 0.05) issues.push(`propEvents[${k}] anchors "${e.at.word}" at ${t.toFixed(2)}s, outside this shot (${start.toFixed(2)}-${end.toFixed(2)}s)`);
      });
      // geometric checks (framing, caption zone, blocked views, props) on the shot as it will be rendered
      issues.push(
        ...checkShot({ ...s, start, duration: Math.max(0.1, end - start), events: [], propEvents: [] }, set)
          // a floor gap is the set's problem; the pipeline repairs the set deterministically, a shot can't
          .filter((x) => x.severity === 'error' && x.check !== 'floor-gap')
          .map((x) => x.message),
      );
      return issues;
    },
  }).then((s) => ({ ...s, start: i === 0 ? 0 : plan.startWord, duration: undefined, transitionIn: { type: plan.transition, frames: s.transitionIn.frames } }));
}

export { normalizeToken };
