/**
 * Script + word timings in, project out.
 *
 *   npm run produce -- script.txt alignment.json projects/my_short [--provider api|cli]
 *       [--model claude-opus-5-5] [--effort medium] [--cli claude] [--cli-args "-p"]
 *       [--shot-seconds 1.1] [--concurrency 3]
 *
 *   npm run produce -- script.txt projects/my_short --speak [--engine auto|espeak|sapi|say] [--timing words|prefix|proportional]
 *       No recording: the script is spoken by a text-to-speech engine first, and its exact timings are used.
 *
 * api: the Claude API (needs ANTHROPIC_API_KEY, or `ant auth login`).
 * cli: any local CLI that reads a prompt on stdin and prints the answer (Claude Code: `claude -p`, Gemini CLI: `gemini -p`).
 */
import { readFileSync } from 'node:fs';
import { AnthropicProvider, CliProvider, produceProject, type LlmProvider } from '@shortstudio/agents';
import type { TimingMode } from '@shortstudio/audio';
import { Alignment } from '@shortstudio/schema';
import { speakToProject } from './voiceover';

const a = process.argv.slice(2);
const speakIt = a.includes('--speak');
if (speakIt) a.splice(a.indexOf('--speak'), 1);
const pos: string[] = [];
const opt: Record<string, string> = {};
for (let i = 0; i < a.length; i++) a[i]!.startsWith('--') ? (opt[a[i]!.slice(2)] = a[++i] ?? '') : pos.push(a[i]!);

const [scriptPath, alignmentPath, outDir] = speakIt ? [pos[0], undefined, pos[1]] : pos;
if (!scriptPath || !outDir || (!speakIt && !alignmentPath)) throw new Error('usage: produce <script.txt> <alignment.json> <outDir> [--provider api|cli] ...   or   produce <script.txt> <outDir> --speak ...');

let provider: LlmProvider;
if ((opt.provider ?? 'api') === 'cli') {
  provider = new CliProvider({ command: opt.cli ?? 'claude', args: (opt['cli-args'] ?? '-p').split(/\s+/).filter(Boolean) });
} else {
  provider = new AnthropicProvider({ model: opt.model, effort: opt.effort as never });
}

const script = readFileSync(scriptPath, 'utf8');
let alignment: Alignment;
if (speakIt) {
  const v = await speakToProject(script, outDir, { engine: opt.engine, voice: opt.voice, rate: opt.rate ? Number(opt.rate) : undefined, timing: opt.timing as TimingMode | undefined });
  alignment = v.alignment;
  console.log(`voiceover: ${v.duration.toFixed(1)}s with ${v.engine}`);
} else {
  alignment = Alignment.parse(JSON.parse(readFileSync(alignmentPath!, 'utf8')));
}

const t0 = Date.now();
const result = await produceProject({
  provider,
  script,
  alignment,
  outDir,
  targetShotSeconds: opt['shot-seconds'] ? Number(opt['shot-seconds']) : undefined,
  concurrency: opt.concurrency ? Number(opt.concurrency) : undefined,
  onProgress: (m) => console.log(m),
});
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s with ${provider.name}: ${result.shots.length} shots, ${result.sets.length} sets -> ${outDir}`);
console.log(`next: npm run qa -- ${outDir} --fix && npm run render -- ${outDir} out/short.mp4`);
