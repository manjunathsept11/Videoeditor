import { z } from 'zod';
import { Anchor, orderedShots, resolveAnchor, type Alignment, type Bundle } from '@shortstudio/schema';
import { walkPlans } from '@shortstudio/engine/pure';

export const SfxKind = z.enum(['impact', 'whoosh', 'tick', 'ding', 'pageflip', 'steps']);
export type SfxKind = z.infer<typeof SfxKind>;

/** Loudness classes, in LU relative to the voiceover (spec): hits -10, whooshes -15, music -18. */
export const LU = { hit: -10, whoosh: -15, music: -18 } as const;
export const KIND_CLASS: Record<SfxKind, 'hit' | 'whoosh'> = {
  impact: 'hit',
  tick: 'hit',
  ding: 'hit',
  steps: 'hit',
  whoosh: 'whoosh',
  pageflip: 'whoosh',
};

export const SfxCue = z.object({
  at: z.union([z.number(), Anchor]),
  kind: SfxKind,
  /** Use your own audio file for this cue instead of the synthesized sound (path relative to the project). */
  file: z.string().optional(),
  /** Extra dB on top of the class level. */
  gain: z.number().default(0),
});

/** audio/sfx_manifest.json */
export const SfxManifest = z.object({
  version: z.literal(1).default(1),
  /** Also add cues derived from the timeline (transitions, prop landings, jolts, footfalls). */
  auto: z.boolean().default(true),
  cues: z.array(SfxCue).default([]),
});
export type SfxManifest = z.infer<typeof SfxManifest>;

export interface Cue {
  /** Seconds on the project timeline. */
  at: number;
  kind: SfxKind;
  file?: string;
  gainDb: number;
  /** For `steps`: seconds after `at` of each footfall. */
  offsets?: number[];
  /** Higher survives the density cap. */
  priority: number;
  source: 'auto' | 'manifest';
  why: string;
}

/** Spec: 12-20 SFX per minute. */
export const DENSITY = { min: 12, max: 20 } as const;

/**
 * Cues derived from the timeline, all landing on the exact frames the engine uses: a whoosh into every shot change,
 * a tick/ding/page-flip where each prop reaches its value, an impact on every jolt, and one footstep cue per walk
 * with a footfall at every step the foot-lock rig plants.
 */
export function autoSfx(bundle: Bundle): Cue[] {
  const cues: Cue[] = [];
  const shots = orderedShots(bundle);
  shots.forEach((s, i) => {
    if (i > 0) cues.push({ at: Math.max(0, s.start - 0.08), kind: 'whoosh', gainDb: 0, priority: 2, source: 'auto', why: `${s.transitionIn.type} into ${s.id}` });
    for (const e of s.propEvents) {
      const prop = s.props.find((p) => p.id === e.prop);
      if (!prop) continue;
      const kind: SfxKind = prop.kind === 'counter' || prop.kind === 'clock' ? 'tick' : prop.kind === 'dial' ? 'ding' : prop.kind === 'calendar' ? 'pageflip' : 'whoosh';
      cues.push({ at: e.at, kind, gainDb: 0, priority: 3, source: 'auto', why: `${prop.kind} "${prop.id}" lands` });
    }
    for (const e of s.events) if (e.type === 'jolt') cues.push({ at: e.at, kind: 'impact', gainDb: 0, priority: 5, source: 'auto', why: `${e.actor} jolts` });
    for (const a of s.actors) {
      for (const p of walkPlans(s, a)) {
        const offsets = Array.from({ length: p.n }, (_, k) => (k + 1) * p.Ts);
        cues.push({ at: p.t0, kind: 'steps', offsets, gainDb: 0, priority: 2, source: 'auto', why: `${a.id} walks (${p.n} steps)` });
      }
    }
  });
  return cues.sort((a, b) => a.at - b.at);
}

/** Resolve a hand-written manifest (word anchors allowed) into cues. */
export function manifestCues(manifest: SfxManifest, alignment?: Alignment): { cues: Cue[]; problems: string[] } {
  const problems: string[] = [];
  const cues: Cue[] = [];
  manifest.cues.forEach((c, i) => {
    let at: number;
    if (typeof c.at === 'number') at = c.at;
    else if (!alignment) {
      problems.push(`sfx_manifest cue ${i} uses word anchor "${c.at.word}" but there is no alignment`);
      return;
    } else {
      const r = resolveAnchor(alignment, c.at);
      if (typeof r === 'string') {
        problems.push(`sfx_manifest cue ${i}: ${r}`);
        return;
      }
      at = r;
    }
    cues.push({ at, kind: c.kind, file: c.file, gainDb: c.gain, priority: 10, source: 'manifest', why: `manifest cue ${i}` });
  });
  return { cues, problems };
}

export const hitsPerMinute = (cues: readonly Cue[], seconds: number): number => (seconds > 0 ? (cues.length * 60) / seconds : 0);

/**
 * Keep the highest-priority cues so the track stays within the density cap. Hand-written manifest cues carry the
 * highest priority and are never dropped before auto cues. Returns cues in time order.
 */
export function limitDensity(cues: readonly Cue[], seconds: number, maxPerMinute: number = DENSITY.max): { kept: Cue[]; dropped: Cue[] } {
  const budget = Math.max(1, Math.floor((maxPerMinute * seconds) / 60));
  if (cues.length <= budget) return { kept: [...cues].sort((a, b) => a.at - b.at), dropped: [] };
  const ranked = [...cues].sort((a, b) => b.priority - a.priority || a.at - b.at);
  const keptSet = new Set(ranked.slice(0, budget));
  return {
    kept: cues.filter((c) => keptSet.has(c)).sort((a, b) => a.at - b.at),
    dropped: cues.filter((c) => !keptSet.has(c)),
  };
}
