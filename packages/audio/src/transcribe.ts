import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import type { Alignment } from '@shortstudio/schema';
import { SAMPLE_RATE, decodeAudio } from './wav';
import { importWhisperJson } from './whisper';

export interface TranscribeOptions {
  /** The executable. Defaults to `whisperx` on the PATH. */
  command?: string;
  /** Whisper model: tiny, base, small, medium, large-v3 ... */
  model?: string;
  language?: string;
  /** cpu or cuda. */
  device?: string;
  /** float16 (GPU), int8 (CPU)... */
  computeType?: string;
  /** Extra arguments passed straight to the command. */
  extraArgs?: string[];
  /** Kill the run after this long. */
  timeoutMs?: number;
  onLog?: (line: string) => void;
}

export interface Transcription {
  alignment: Alignment;
  /** The raw WhisperX JSON, kept for debugging. */
  raw: unknown;
}

/**
 * Run WhisperX on a recording and import its word timestamps. WhisperX is a Python tool (`pip install whisperx`) that
 * downloads its models on first use; this only drives its command line, so everything about the models themselves,
 * including their accuracy, is whatever the installed WhisperX does.
 *
 * `audioPath` should be the audio the alignment will be used with (the tightened voiceover), so the times need no remap.
 */
export async function transcribe(audioPath: string, opts: TranscribeOptions = {}): Promise<Transcription> {
  if (!existsSync(audioPath)) throw new Error(`audio file not found: ${audioPath}`);
  const command = opts.command ?? 'whisperx';
  const dir = mkdtempSync(join(tmpdir(), 'whisperx-'));
  const args = [
    audioPath,
    '--output_dir', dir,
    '--output_format', 'json',
    '--model', opts.model ?? 'small',
    ...(opts.language ? ['--language', opts.language] : []),
    ...(opts.device ? ['--device', opts.device] : []),
    ...(opts.computeType ? ['--compute_type', opts.computeType] : []),
    ...(opts.extraArgs ?? []),
  ];
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let tail = '';
      const take = (d: Buffer) => {
        const s = d.toString();
        tail = (tail + s).slice(-2000);
        if (opts.onLog) for (const line of s.split(/\r?\n/)) if (line.trim()) opts.onLog(line);
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      const timer = opts.timeoutMs ? setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${command} timed out after ${opts.timeoutMs} ms`)); }, opts.timeoutMs) : undefined;
      child.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(new Error(e.code === 'ENOENT'
          ? `could not find "${command}". Install WhisperX (pip install whisperx) and make sure it is on the PATH, or pass --command <path>. Alternatively run it yourself and use import-whisper.`
          : `could not run "${command}": ${e.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error(`${command} exited ${code}:\n${tail.trim().split('\n').slice(-8).join('\n')}`));
      });
    });

    const jsonPath = join(dir, `${basename(audioPath, extname(audioPath))}.json`);
    if (!existsSync(jsonPath)) throw new Error(`${command} finished but wrote no ${basename(jsonPath)} in its output directory`);
    const raw = JSON.parse(readFileSync(jsonPath, 'utf8')) as unknown;
    const duration = decodeAudio(audioPath).length / SAMPLE_RATE;
    return { alignment: importWhisperJson(raw, duration), raw };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
