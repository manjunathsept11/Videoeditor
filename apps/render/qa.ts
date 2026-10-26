/**
 * Quality gate.
 *
 *   npm run qa -- <projectDir>          report problems (exit 1 on errors)
 *   npm run qa -- <projectDir> --fix    auto-fix what has a fix, patch shots/*.json (camera and actor
 *                                       positions only; anchors and everything else are untouched)
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runQualityGate, type Patch } from '@shortstudio/qa';
import { loadProject } from './project';

export function applyPatches(projectDir: string, patches: Record<string, Patch>, setPatches: Record<string, unknown> = {}): string[] {
  const dir = join(projectDir, 'shots');
  const written: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const path = join(dir, f);
    const json = JSON.parse(readFileSync(path, 'utf8'));
    const patch = patches[json.id];
    if (!patch) continue;
    if (patch.camera) json.camera = { ...json.camera, ...patch.camera };
    if (patch.actors) {
      for (const a of json.actors ?? []) if (patch.actors[a.id]) a.position = patch.actors[a.id];
    }
    writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
    written.push(path);
  }
  const setDir = join(projectDir, 'sets');
  for (const f of readdirSync(setDir).filter((x) => x.endsWith('.json'))) {
    const path = join(setDir, f);
    const id = JSON.parse(readFileSync(path, 'utf8')).id;
    if (setPatches[id]) {
      writeFileSync(path, JSON.stringify(setPatches[id], null, 2) + '\n');
      written.push(path);
    }
  }
  return written;
}

export function printGate(result: ReturnType<typeof runQualityGate>): void {
  for (const [shot, fixes] of Object.entries(result.fixes)) for (const f of fixes) console.log(`  fixed ${shot}: ${f}`);
  for (const i of result.issues) console.log(`  ${i.severity === 'error' ? 'ERROR' : 'warn '} ${i.shot}${i.actor ? `/${i.actor}` : ''} [${i.check}] ${i.message}`);
}

if (process.argv[1]?.endsWith('qa.ts')) {
  const [dir, ...rest] = process.argv.slice(2);
  if (!dir) throw new Error('usage: qa <projectDir> [--fix]');
  const fix = rest.includes('--fix');
  const { bundle } = loadProject(dir);
  const result = runQualityGate(bundle, { fix });
  printGate(result);
  if (fix && (Object.keys(result.patches).length || Object.keys(result.setPatches).length)) {
    console.log(`patched: ${applyPatches(dir, result.patches, result.setPatches).join(', ')}`);
  }
  const errs = result.issues.filter((i) => i.severity === 'error').length;
  console.log(result.passed ? `quality gate passed${result.issues.length ? ` (${result.issues.length} warning(s))` : ''}` : `quality gate FAILED: ${errs} error(s)`);
  process.exit(result.passed ? 0 : 1);
}
