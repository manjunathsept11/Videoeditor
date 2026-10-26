import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Alignment, parseBundle, type Bundle } from '@shortstudio/schema';

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));
const readDir = (d: string) =>
  readdirSync(d).filter((f) => f.endsWith('.json')).sort().map((f) => readJson(join(d, f)));

export const VOICEOVER = 'audio/voiceover_tight.wav';
export const ALIGNMENT = 'audio/alignment.json';

export interface LoadedProject {
  bundle: Bundle;
  /** Absolute-or-relative path of the tightened voiceover, if the project has one. */
  voiceover?: string;
}

/** Load project.json + sets/ + shots/, resolving word anchors against audio/alignment.json when present. */
export function loadProject(dir: string): LoadedProject {
  const alignPath = join(dir, ALIGNMENT);
  const alignment = existsSync(alignPath) ? Alignment.parse(readJson(alignPath)) : undefined;
  const bundle = parseBundle(
    { project: readJson(join(dir, 'project.json')), sets: readDir(join(dir, 'sets')), shots: readDir(join(dir, 'shots')) },
    { alignment },
  );
  const vo = join(dir, VOICEOVER);
  return { bundle, voiceover: existsSync(vo) ? vo : undefined };
}
