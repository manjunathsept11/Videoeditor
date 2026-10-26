import { effectiveSet, type Alignment, type SetDef, type ShotSource } from '@shortstudio/schema';
import { ShotSource as ShotSourceSchema } from '@shortstudio/schema';
import { EDIT_SYSTEM } from './prompts';
import { generateValidated } from './generate';
import type { LlmProvider } from './provider';
import { checkShotSource } from './shotChecks';

export interface EditTarget {
  kind: 'actor' | 'prop' | 'set';
  id: string;
}

export interface EditShotInput {
  /** The shot exactly as written on disk (word anchors, no hard-coded durations). */
  shot: ShotSource;
  /** Every set in the project, by id; the shot may switch to another when asked. */
  sets: Record<string, SetDef>;
  alignment: Alignment;
  /** The shot's window on the project timeline, seconds. */
  start: number;
  end: number;
  target: EditTarget;
  instruction: string;
  /** The project has no voiceover alignment, so times are plain seconds on the project timeline. */
  allowSeconds?: boolean;
}

/** The JSON of the thing that was clicked, as the shot currently has it. */
export function describeTarget(input: EditShotInput): string {
  const { shot, target } = input;
  if (target.kind === 'actor') return JSON.stringify(shot.actors.find((a) => a.id === target.id) ?? null);
  if (target.kind === 'prop') return JSON.stringify(shot.props.find((p) => p.id === target.id) ?? null);
  const set = effectiveSet(input.sets[shot.set]!, shot);
  return JSON.stringify(set.objects.find((o) => o.id === target.id) ?? null);
}

/**
 * Click-to-edit's brain: rewrite ONE shot file from a click target and an instruction. The answer is validated like a
 * freshly built shot (schema, anchors, the quality gate) and, on top, may not change what an edit must never touch:
 * the shot's id, its start time, or the shared set.
 */
export function editShot(provider: LlmProvider, input: EditShotInput): Promise<ShotSource> {
  const { shot, sets, alignment, start, end, target } = input;
  const base = sets[shot.set]!;
  const eff = effectiveSet(base, shot);
  const words = alignment.words.filter((w) => w.start >= start - 1e-6 && w.start < end).map((w) => w.text);
  const objects = eff.objects.map((o) => `${o.kind}:${o.id}${'position' in o ? `@[${o.position.join(',')}]` : ''}`).join(' ');

  const user =
    `The person clicked: ${target.kind} "${target.id}"\nIts current JSON: ${describeTarget(input)}\n\n` +
    `Instruction: ${input.instruction}\n\n` +
    `Current shot JSON:\n${JSON.stringify(shot, null, 1)}\n\n` +
    `Objects in this shot's set "${shot.set}" (after this shot's overrides): ${objects}\n` +
    `Other sets you may switch to if asked: ${Object.keys(sets).filter((id) => id !== shot.set).join(', ') || '(none)'}\n` +
    (input.allowSeconds
      ? `This project has no voiceover alignment, so every time is plain seconds on the project timeline (not a word anchor). The shot runs ${start.toFixed(2)}s to ${end.toFixed(2)}s; keep times inside that range.`
      : `The shot runs ${start.toFixed(2)}s to ${end.toFixed(2)}s. Words inside it (anchor to these only): ${words.join(' ') || '(none)'}`);

  return generateValidated({
    provider,
    what: `edit of shot "${shot.id}"`,
    system: EDIT_SYSTEM,
    user,
    schema: ShotSourceSchema,
    check: (s) => {
      const issues: string[] = [];
      if (s.id !== shot.id) issues.push(`id must stay "${shot.id}"`);
      if (JSON.stringify(s.start) !== JSON.stringify(shot.start)) issues.push(`start must stay exactly ${JSON.stringify(shot.start)}: timing belongs to the project timeline`);
      const set = sets[s.set];
      if (!set) {
        issues.push(`set "${s.set}" does not exist; the sets are: ${Object.keys(sets).join(', ')}`);
        return issues;
      }
      const baseIds = new Set(set.objects.map((o) => o.id));
      for (const id of s.setOverrides.remove) if (!baseIds.has(id)) issues.push(`setOverrides.remove names "${id}", which is not an object of set "${s.set}"`);
      const dup = s.setOverrides.objects.map((o) => o.id).filter((id, i, a) => a.indexOf(id) !== i);
      if (dup.length) issues.push(`setOverrides.objects repeats ids: ${[...new Set(dup)].join(', ')}`);
      issues.push(...checkShotSource(s, { set, start, end, alignment, allowSeconds: input.allowSeconds }));
      return issues;
    },
  }).then((s) => ({ ...s, duration: shot.duration })); // the length of a shot is the timeline's business too
}
