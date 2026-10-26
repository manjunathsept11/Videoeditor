import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Alignment, parseBundle, type Bundle } from '@shortstudio/schema';

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));
const readDir = (d: string) =>
  readdirSync(d).filter((f) => f.endsWith('.json')).sort().map((f) => readJson(join(d, f)));

export const VOICEOVER = 'audio/voiceover_tight.wav';
export const ALIGNMENT = 'audio/alignment.json';

/** The project's JSON exactly as written on disk (before schema defaults and anchors are applied). */
export interface RawProject {
  project: unknown;
  sets: unknown[];
  shots: unknown[];
  alignment?: unknown;
}

export function readRaw(dir: string): RawProject {
  const alignPath = join(dir, ALIGNMENT);
  return {
    project: readJson(join(dir, 'project.json')),
    sets: readDir(join(dir, 'sets')),
    shots: readDir(join(dir, 'shots')),
    alignment: existsSync(alignPath) ? readJson(alignPath) : undefined,
  };
}

export interface LoadedProject {
  bundle: Bundle;
  /** Absolute-or-relative path of the tightened voiceover, if the project has one. */
  voiceover?: string;
}

/** Load project.json + sets/ + shots/, resolving word anchors against audio/alignment.json when present. */
export function loadProject(dir: string): LoadedProject {
  const raw = readRaw(dir);
  const alignment = raw.alignment === undefined ? undefined : Alignment.parse(raw.alignment);
  const bundle = parseBundle({ project: raw.project, sets: raw.sets, shots: raw.shots }, { alignment });
  const vo = join(dir, VOICEOVER);
  return { bundle, voiceover: existsSync(vo) ? vo : undefined };
}
