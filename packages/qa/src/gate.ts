import { effectiveSet, type Bundle, type SetDef } from '@shortstudio/schema';
import { checkShot, fixShot, type Patch } from './fix';
import { fixSetFloor } from './floor';
import type { Issue } from './framing';

export interface GateResult {
  /** Issues left after any fixes. */
  issues: Issue[];
  /** shot id (or "set:<id>") -> what changed (only when fix is on). */
  fixes: Record<string, string[]>;
  /** shot id -> patch to apply to that shot's JSON (only camera/actor positions). */
  patches: Record<string, Patch>;
  /** set id -> the repaired set (only sets that changed). */
  setPatches: Record<string, SetDef>;
  passed: boolean;
}

/** Run every check across the project; with `fix`, auto-repair what has a repair and report the rest. */
export function runQualityGate(bundle: Bundle, opts: { fix?: boolean } = {}): GateResult {
  const issues: Issue[] = [];
  const fixes: Record<string, string[]> = {};
  const patches: Record<string, Patch> = {};
  const setPatches: Record<string, SetDef> = {};
  const sets = { ...bundle.sets };

  if (opts.fix) {
    // sets first: a gap in the floor is the set's problem, and shots are then checked against the repaired set
    for (const id of bundle.project.sets) {
      const users = bundle.project.shots.map((s) => bundle.shots[s]!).filter((s) => s.set === id);
      const r = fixSetFloor(sets[id]!, users);
      if (r) {
        sets[id] = r.set;
        setPatches[id] = r.set;
        fixes[`set:${id}`] = [r.note];
      }
    }
  }

  for (const id of bundle.project.shots) {
    const shot = bundle.shots[id]!;
    const set = effectiveSet(sets[shot.set]!, shot);
    if (opts.fix) {
      const r = fixShot(shot, set);
      if (r.fixes.length) {
        fixes[id] = r.fixes;
        patches[id] = r.patch;
      }
      issues.push(...r.remaining);
    } else {
      issues.push(...checkShot(shot, set));
    }
  }
  return { issues, fixes, patches, setPatches, passed: !issues.some((i) => i.severity === 'error') };
}
