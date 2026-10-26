import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Alignment, parseBundle, type Bundle, type SetDef, type ShotSource } from '@shortstudio/schema';
import { runQualityGate, type Issue } from '@shortstudio/qa';
import { buildShot, designSet, direct, type Storyboard } from './roles';
import type { LlmProvider } from './provider';

export interface ProduceOptions {
  provider: LlmProvider;
  script: string;
  alignment: Alignment;
  /** Where to write project.json, sets/, shots/ (and copy alignment). Skipped when undefined. */
  outDir?: string;
  name?: string;
  targetShotSeconds?: number;
  /** Parallel set/shot builders. */
  concurrency?: number;
  onProgress?: (msg: string) => void;
}

export interface Production {
  storyboard: Storyboard;
  sets: SetDef[];
  shots: ShotSource[];
  bundle: Bundle;
  /** What the quality gate repaired, and what it still objects to after repairs. */
  fixes: string[];
  remaining: Issue[];
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Script + word timings in, validated project out: Director -> Set Designer(s) -> Scene Builder(s). */
export async function produceProject(o: ProduceOptions): Promise<Production> {
  const say = o.onProgress ?? (() => {});
  const conc = o.concurrency ?? 3;

  say('Director: planning shots');
  const storyboard = await direct(o.provider, { script: o.script, alignment: o.alignment, targetShotSeconds: o.targetShotSeconds });
  say(`Director: ${storyboard.shots.length} shots, ${storyboard.sets.length} sets, ${storyboard.cast.length} characters`);

  const sets = await pool(storyboard.sets, conc, async (s) => {
    say(`Set Designer: ${s.id}`);
    return designSet(o.provider, s);
  });
  const setById = Object.fromEntries(sets.map((s) => [s.id, s]));

  const shots = await pool(storyboard.shots, conc, async (s, i) => {
    say(`Scene Builder: ${s.id}`);
    return buildShot(o.provider, { storyboard, shotIndex: i, set: setById[s.set]!, alignment: o.alignment });
  });

  const project = {
    version: 1,
    name: o.name ?? storyboard.title,
    width: 1080,
    height: 1920,
    fps: 30,
    sets: sets.map((s) => s.id),
    shots: shots.map((s) => s.id),
  };
  // Final gate: the same validation the renderer will run, with deterministic repairs applied first.
  let bundle = parseBundle({ project, sets, shots }, { alignment: o.alignment });
  const gate = runQualityGate(bundle, { fix: true });
  const fixes = Object.entries(gate.fixes).flatMap(([where, notes]) => notes.map((n) => `${where}: ${n}`));
  if (fixes.length) {
    for (const [id, fixed] of Object.entries(gate.setPatches)) sets[sets.findIndex((s) => s.id === id)] = fixed;
    for (const [id, patch] of Object.entries(gate.patches)) {
      const shot = shots.find((s) => s.id === id)!;
      if (patch.camera) shot.camera = patch.camera;
      for (const a of shot.actors) if (patch.actors?.[a.id]) a.position = patch.actors[a.id]!;
    }
    bundle = parseBundle({ project, sets, shots }, { alignment: o.alignment });
    for (const f of fixes) say(`quality gate fixed ${f}`);
  }
  const remaining = runQualityGate(bundle).issues;
  for (const i of remaining) say(`quality gate ${i.severity}: ${i.shot}${i.actor ? `/${i.actor}` : ''} [${i.check}] ${i.message}`);

  if (o.outDir) {
    mkdirSync(join(o.outDir, 'sets'), { recursive: true });
    mkdirSync(join(o.outDir, 'shots'), { recursive: true });
    mkdirSync(join(o.outDir, 'audio'), { recursive: true });
    const w = (p: string, v: unknown) => writeFileSync(join(o.outDir!, p), JSON.stringify(v, null, 2) + '\n');
    w('project.json', project);
    for (const s of sets) w(`sets/${s.id}.json`, s);
    for (const s of shots) w(`shots/${s.id}.json`, s);
    w('audio/alignment.json', o.alignment);
    w('storyboard.json', storyboard);
    say(`wrote project to ${o.outDir}`);
  }
  return { storyboard, sets, shots, bundle, fixes, remaining };
}
