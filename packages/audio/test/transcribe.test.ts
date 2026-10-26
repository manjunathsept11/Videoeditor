import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeWav16 } from '../src/wav';
import { transcribe } from '../src/transcribe';

/*
 * WhisperX itself is a Python model stack that cannot run here, so these tests use a stand-in executable that speaks
 * WhisperX's command line and writes its JSON layout. They prove this wrapper's behaviour (arguments, output
 * discovery, import, errors) and say nothing about the accuracy of the real models.
 */

const dir = mkdtempSync(join(tmpdir(), 'fake-whisperx-'));
const wav = join(dir, 'voice_tight.wav');
writeFileSync(wav, encodeWav16(new Float32Array(48000 * 2).fill(0.1)));

function fake(body: string): string {
  const path = join(dir, `fake-${Math.random().toString(36).slice(2)}.cjs`);
  writeFileSync(path, `#!/usr/bin/env node\nconst fs=require('fs'),path=require('path');\nconst a=process.argv.slice(2);\nconst arg=(n)=>a[a.indexOf(n)+1];\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

describe('transcribe', () => {
  it('passes the options through, finds <basename>.json and imports the word times', async () => {
    const argsFile = join(dir, 'args.json');
    const cmd = fake(`
      fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(a));
      const out = path.join(arg('--output_dir'), path.basename(a[0]).replace(/\\.[^.]+$/, '') + '.json');
      fs.writeFileSync(out, JSON.stringify({ segments: [{ words: [
        { word: ' Gambling', start: 0.1, end: 0.6 }, { word: 'is', start: 0.6, end: 0.8 }, { word: '5', }, { word: 'rigged.', start: 1.0, end: 1.5 }] }] }));
      console.error('aligning...');
    `);
    const logs: string[] = [];
    const r = await transcribe(wav, { command: cmd, model: 'tiny', language: 'en', device: 'cpu', computeType: 'int8', extraArgs: ['--vad_onset', '0.4'], onLog: (l) => logs.push(l) });

    const args = JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
    expect(args[0]).toBe(wav);
    for (const [flag, value] of [['--model', 'tiny'], ['--language', 'en'], ['--device', 'cpu'], ['--compute_type', 'int8'], ['--output_format', 'json'], ['--vad_onset', '0.4']]) {
      expect(args[args.indexOf(flag!) + 1]).toBe(value);
    }
    expect(r.alignment.words.map((w) => w.text)).toEqual(['Gambling', 'is', '5', 'rigged.']);
    expect(r.alignment.words[0]).toMatchObject({ start: 0.1, end: 0.6 });
    expect(r.alignment.words[2]!.start).toBeCloseTo(0.8, 6); // untimed number spread between neighbours
    expect(r.alignment.duration).toBeCloseTo(2, 3);
    expect(logs).toContain('aligning...');
  });

  it('explains a missing install', async () => {
    await expect(transcribe(wav, { command: join(dir, 'no-such-whisperx') })).rejects.toThrow(/pip install whisperx/);
  });

  it('reports the tool failing, with its last output', async () => {
    const cmd = fake(`console.error('CUDA out of memory'); process.exit(3);`);
    await expect(transcribe(wav, { command: cmd })).rejects.toThrow(/exited 3[\s\S]*CUDA out of memory/);
  });

  it('reports a run that wrote nothing', async () => {
    await expect(transcribe(wav, { command: fake(`process.exit(0);`) })).rejects.toThrow(/wrote no voice_tight\.json/);
  });

  it('rejects a missing audio file before running anything', async () => {
    await expect(transcribe(join(dir, 'nope.wav'), { command: fake(`process.exit(0);`) })).rejects.toThrow(/not found/);
  });

  it('kills a run that hangs', async () => {
    await expect(transcribe(wav, { command: fake(`setTimeout(()=>{}, 60000);`), timeoutMs: 300 })).rejects.toThrow(/timed out/);
  }, 10000);
});
