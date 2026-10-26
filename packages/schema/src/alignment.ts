import { z } from 'zod';
import type { Anchor, Shot, ShotSource, TimeRef } from './index';

/** Word-level timing of the (tightened) voiceover, in seconds. */
export const Alignment = z
  .object({
    version: z.literal(1).default(1),
    /** Length of the voiceover audio; used as the end of the last shot when it has no duration. */
    duration: z.number().positive().optional(),
    words: z.array(z.object({ text: z.string(), start: z.number().nonnegative(), end: z.number().nonnegative() })),
  })
  .superRefine((a, ctx) => {
    let prev = 0;
    a.words.forEach((w, i) => {
      if (w.end < w.start) ctx.addIssue({ code: 'custom', path: ['words', i], message: `word "${w.text}" ends before it starts` });
      if (w.start < prev - 1e-6) ctx.addIssue({ code: 'custom', path: ['words', i], message: `word "${w.text}" starts before the previous word` });
      prev = Math.max(prev, w.start);
    });
  });
export type Alignment = z.infer<typeof Alignment>;

/** Lowercase, NFKC, letters and digits only, so "Gambling," matches "gambling". */
export function normalizeToken(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

interface Token {
  token: string;
  start: number;
  end: number;
}

function tokens(a: Alignment): Token[] {
  const out: Token[] = [];
  for (const w of a.words) for (const token of normalizeToken(w.text)) out.push({ token, start: w.start, end: w.end });
  return out;
}

/** Seconds for an anchor on the alignment, or an error string. */
export function resolveAnchor(a: Alignment, anchor: Anchor, toks: Token[] = tokens(a)): number | string {
  const want = normalizeToken(anchor.word);
  if (want.length === 0) return `anchor "${anchor.word}" has no letters or digits`;
  let seen = 0;
  for (let i = 0; i + want.length <= toks.length; i++) {
    if (!want.every((t, k) => toks[i + k]!.token === t)) continue;
    if (++seen < anchor.nth) continue;
    const t = anchor.edge === 'start' ? toks[i]!.start : toks[i + want.length - 1]!.end;
    return t + anchor.offset;
  }
  return seen === 0
    ? `word "${anchor.word}" not found in the alignment`
    : `word "${anchor.word}" occurs ${seen} time(s) but nth=${anchor.nth} was requested`;
}

/**
 * Turn on-disk shots (anchors, optional durations) into engine shots (seconds).
 * `order` is the project's shot list; an omitted duration runs to the next shot's start.
 */
export function resolveShots(
  sources: Record<string, ShotSource>,
  order: string[],
  alignment?: Alignment,
): { shots: Record<string, Shot>; issues: string[] } {
  const issues: string[] = [];
  const toks = alignment ? tokens(alignment) : [];

  const time = (ref: TimeRef, where: string): number | undefined => {
    if (typeof ref === 'number') return ref;
    if (!alignment) {
      issues.push(`${where} uses word anchor "${ref.word}" but no alignment was provided`);
      return undefined;
    }
    const r = resolveAnchor(alignment, ref, toks);
    if (typeof r === 'string') {
      issues.push(`${where}: ${r}`);
      return undefined;
    }
    return r;
  };

  const ordered = order.map((id) => sources[id]).filter((s): s is ShotSource => !!s);
  const starts = ordered.map((s) => time(s.start, `shot "${s.id}" start`));

  const shots: Record<string, Shot> = {};
  ordered.forEach((src, i) => {
    const start = starts[i];
    if (start === undefined) return;
    let duration = src.duration;
    if (duration === undefined) {
      const next = i + 1 < ordered.length ? starts[i + 1] : alignment?.duration;
      if (next === undefined) {
        const why = i + 1 < ordered.length ? 'next shot start is unresolved' : 'last shot needs a duration (or alignment.duration)';
        issues.push(`shot "${src.id}" has no duration and ${why}`);
        return;
      }
      duration = next - start;
      if (duration <= 0) {
        issues.push(`shot "${src.id}" would have non-positive duration (${duration.toFixed(3)}s): shots must start in order`);
        return;
      }
    }
    const events = src.events.flatMap((e, k) => {
      const at = time(e.at, `shot "${src.id}" events[${k}]`);
      return at === undefined ? [] : [{ ...e, at } as Shot['events'][number]];
    });
    const propEvents = src.propEvents.flatMap((e, k) => {
      const at = time(e.at, `shot "${src.id}" propEvents[${k}]`);
      return at === undefined ? [] : [{ ...e, at }];
    });
    shots[src.id] = { ...src, start, duration, events, propEvents };
  });
  return { shots, issues };
}
