import { orderedShots, projectDuration, type Bundle } from '@shortstudio/schema';
import { dissolveAlpha, dissolveWindow } from './rules';

export interface Layer {
  shotId: string;
  /** Seconds since the shot started (clamped >= 0 for an incoming dissolve). */
  localT: number;
  /** Opacity of this layer; layers composite bottom to top. */
  alpha: number;
}

/**
 * Which shots are visible at timeline time `t`, and how they blend. Pure.
 * Outgoing shots keep running through a dissolve so motion never freezes.
 */
export function resolveAt(bundle: Bundle, t: number): Layer[] {
  const shots = orderedShots(bundle);
  if (shots.length === 0) return [];

  for (let i = 1; i < shots.length; i++) {
    const cur = shots[i]!;
    if (cur.transitionIn.type !== 'dissolve') continue;
    const w = dissolveWindow(cur.start, cur.transitionIn.frames);
    if (t >= w.from && t < w.to) {
      const prev = shots[i - 1]!;
      return [
        { shotId: prev.id, localT: t - prev.start, alpha: 1 },
        { shotId: cur.id, localT: Math.max(0, t - cur.start), alpha: dissolveAlpha(t, cur.start, cur.transitionIn.frames) },
      ];
    }
  }

  let active = shots[0]!;
  for (const s of shots) if (s.start <= t) active = s;
  return [{ shotId: active.id, localT: Math.max(0, t - active.start), alpha: 1 }];
}

export function frameCount(bundle: Bundle): number {
  return Math.round(projectDuration(bundle) * bundle.project.fps);
}
