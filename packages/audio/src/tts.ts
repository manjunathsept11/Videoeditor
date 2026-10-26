import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Alignment } from '@shortstudio/schema';
import { clampSilences, trimSilence } from './silence';
import { SAMPLE_RATE, parseWav, resample } from './wav';
import { remapAlignment } from './whisper';

export interface TtsResult {
  samples: Float32Array;
  sampleRate: number;
}

/** Anything that turns text into speech. Local engines, the OS voices, or a cloud service can all sit behind this. */
export interface TtsProvider {
  readonly name: string;
  synthesize(text: string): Promise<TtsResult>;
}

// ------------------------------------------------------------------ process helper

function run(command: string, args: string[], opts: { stdin?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: opts.env ?? process.env });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`could not run "${command}": ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${command} exited ${code}: ${err.trim().slice(0, 400)}`))));
    child.stdin.on('error', () => {});
    child.stdin.end(opts.stdin ?? '');
  });
}

export const commandExists = (command: string, probe: string[] = ['--version']): boolean => spawnSync(command, probe, { stdio: 'ignore' }).status === 0;

// ------------------------------------------------------------------------ engines

export interface EspeakOptions {
  command?: string;
  /** Voice/language, e.g. "en-us", "en-gb", "ja". */
  voice?: string;
  /** Words per minute. */
  speed?: number;
  /** 0-99. */
  pitch?: number;
}

/** espeak-ng: small, fast, offline, free and robotic. Text goes in on stdin, a WAV comes out on stdout. */
export class EspeakTts implements TtsProvider {
  readonly name = 'espeak-ng';
  constructor(private o: EspeakOptions = {}) {}
  async synthesize(text: string): Promise<TtsResult> {
    const args = ['-v', this.o.voice ?? 'en-us', '-s', String(this.o.speed ?? 165), '-p', String(this.o.pitch ?? 50), '--stdin', '--stdout'];
    return parseWav(await run(this.o.command ?? 'espeak-ng', args, { stdin: text }));
  }
}

export interface SapiOptions {
  voice?: string;
  /** -10 (slowest) to 10 (fastest). */
  rate?: number;
}

/**
 * Windows' built-in voices (System.Speech) through PowerShell: nothing to install on the machine the app targets.
 * Text and file path travel in environment variables so no quoting can break the command.
 */
export class SapiTts implements TtsProvider {
  readonly name = 'windows-sapi';
  constructor(private o: SapiOptions = {}) {}
  async synthesize(text: string): Promise<TtsResult> {
    const dir = mkdtempSync(join(tmpdir(), 'sapi-'));
    const out = join(dir, 'speech.wav');
    const script =
      'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
      'if ($env:SS_VOICE) { $s.SelectVoice($env:SS_VOICE) }; $s.Rate = [int]$env:SS_RATE; ' +
      '$s.SetOutputToWaveFile($env:SS_OUT); $s.Speak($env:SS_TEXT); $s.Dispose()';
    try {
      await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, SS_TEXT: text, SS_OUT: out, SS_VOICE: this.o.voice ?? '', SS_RATE: String(this.o.rate ?? 0) },
      });
      return parseWav(readFileSync(out));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export interface SayOptions {
  voice?: string;
  /** Words per minute. */
  rate?: number;
}

/** macOS `say`. */
export class SayTts implements TtsProvider {
  readonly name = 'macos-say';
  constructor(private o: SayOptions = {}) {}
  async synthesize(text: string): Promise<TtsResult> {
    const dir = mkdtempSync(join(tmpdir(), 'say-'));
    const out = join(dir, 'speech.wav');
    try {
      await run('say', ['-o', out, '--file-format=WAVE', '--data-format=LEI16@22050', ...(this.o.voice ? ['-v', this.o.voice] : []), ...(this.o.rate ? ['-r', String(this.o.rate)] : []), '-f', '-'], { stdin: text });
      return parseWav(readFileSync(out));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export interface CommandTtsOptions {
  name?: string;
  command: string;
  /** Arguments; `{out}` becomes a temp WAV path when output is "file". */
  args: string[];
  output: 'stdout' | 'file';
}

/** Any TTS CLI that reads text on stdin and writes a WAV (Piper, Coqui, a cloud wrapper script...). */
export class CommandTts implements TtsProvider {
  readonly name: string;
  constructor(private o: CommandTtsOptions) {
    this.name = o.name ?? `command:${o.command}`;
  }
  async synthesize(text: string): Promise<TtsResult> {
    if (this.o.output === 'stdout') return parseWav(await run(this.o.command, this.o.args, { stdin: text }));
    const dir = mkdtempSync(join(tmpdir(), 'tts-'));
    const out = join(dir, 'speech.wav');
    try {
      await run(this.o.command, this.o.args.map((a) => a.replace('{out}', out)), { stdin: text });
      return parseWav(readFileSync(out));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** The engine for a name; "auto" picks the operating system's own (SAPI on Windows, `say` on macOS, espeak-ng elsewhere). */
export function ttsFromName(name: string, o: { voice?: string; speed?: number } = {}): TtsProvider {
  const n = name === 'auto' ? (process.platform === 'win32' ? 'sapi' : process.platform === 'darwin' ? 'say' : 'espeak') : name;
  if (n === 'sapi') return new SapiTts({ voice: o.voice, rate: o.speed });
  if (n === 'say') return new SayTts({ voice: o.voice, rate: o.speed });
  if (n === 'espeak') return new EspeakTts({ voice: o.voice, speed: o.speed });
  throw new Error(`unknown TTS engine "${name}" (use auto, espeak, sapi or say)`);
}

// ------------------------------------------------------------------------- speak

export type TimingMode =
  /**
   * Synthesize the sentence once for natural prosody, and estimate each word's end from the length of its prefix.
   * Approximate: engines stretch the last word of any utterance, so boundaries can be off by a word's fraction.
   */
  | 'prefix'
  /** Synthesize every word separately: timings exact by construction (the default), delivery choppier. */
  | 'words'
  /** One synthesis per sentence, word boundaries shared out by length. Cheapest, roughest. */
  | 'proportional';

export interface SpeakOptions {
  sampleRate?: number;
  timing?: TimingMode;
  /** Silence between sentences, seconds. Kept at or under the 0.2s pause limit. */
  pause?: number;
  /** Silence between words in "words" mode. */
  wordGap?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface SpeakResult {
  samples: Float32Array;
  sampleRate: number;
  alignment: Alignment;
  duration: number;
  sentences: number;
  /** How the word times were found. */
  timing: TimingMode;
}

/** Sentences of a script, with paragraph breaks marked so they can pause a little longer. */
export function splitSentences(text: string): { text: string; paragraphEnd: boolean }[] {
  const out: { text: string; paragraphEnd: boolean }[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const flat = para.replace(/\s+/g, ' ').trim();
    if (!flat) continue;
    const parts = flat.split(/(?<=[.!?。！？…]["')\]]*)\s+/).map((s) => s.trim()).filter(Boolean);
    parts.forEach((s, i) => out.push({ text: s, paragraphEnd: i === parts.length - 1 }));
  }
  return out;
}

const rmsAt = (x: Float32Array, i: number, win: number) => {
  let s = 0;
  const end = Math.min(x.length, i + win);
  for (let k = Math.max(0, i); k < end; k++) s += x[k]! * x[k]!;
  return Math.sqrt(s / Math.max(1, end - Math.max(0, i)));
};

/** Move a word boundary to the quietest 10 ms within +-`radius` seconds, but only when it is clearly a dip. */
export function snapToValley(x: Float32Array, sr: number, t: number, radius = 0.06): number {
  const win = Math.round(0.01 * sr);
  const centre = Math.round(t * sr);
  const r = Math.round(radius * sr);
  let best = centre, bestV = Infinity, around = 0, n = 0;
  for (let i = Math.max(0, centre - r); i <= Math.min(x.length - win, centre + r); i += Math.round(0.002 * sr)) {
    const v = rmsAt(x, i, win);
    around += v;
    n++;
    if (v < bestV) { bestV = v; best = i; }
  }
  return n && bestV < 0.5 * (around / n) ? (best + win / 2) / sr : t;
}

async function synth(tts: TtsProvider, text: string, sr: number): Promise<Float32Array> {
  const r = await tts.synthesize(text);
  return resample(r.samples, r.sampleRate, sr);
}

/**
 * Script in, voiceover and word timings out, with no speech recognition: the engine made the audio, so the timing is
 * ours to know. The result obeys the 0.2 s pause limit (a final silence clamp is applied and the timings are remapped
 * through it), so it is already a "tight" voiceover.
 */
export async function speak(script: string, tts: TtsProvider, opts: SpeakOptions = {}): Promise<SpeakResult> {
  const sr = opts.sampleRate ?? SAMPLE_RATE;
  const timing = opts.timing ?? 'words';
  const pause = Math.min(opts.pause ?? 0.18, 0.2);
  const wordGap = opts.wordGap ?? 0.04;
  const sentences = splitSentences(script);
  if (sentences.length === 0) throw new Error('the script is empty');

  const chunks: Float32Array[] = [];
  const words: { text: string; start: number; end: number }[] = [];
  let t = 0;
  const push = (x: Float32Array) => {
    chunks.push(x);
    t += x.length / sr;
  };
  const silence = (s: number) => push(new Float32Array(Math.round(s * sr)));

  for (let si = 0; si < sentences.length; si++) {
    const sentence = sentences[si]!;
    const toks = sentence.text.split(/\s+/).filter(Boolean);
    opts.onProgress?.(si, sentences.length);

    if (timing === 'words') {
      for (let k = 0; k < toks.length; k++) {
        const w = trimSilence(await synth(tts, toks[k]!, sr), sr, { keep: 0.01 }).samples;
        const start = t;
        push(w);
        words.push({ text: toks[k]!, start, end: t });
        if (k < toks.length - 1) silence(wordGap);
      }
    } else {
      const S = trimSilence(await synth(tts, sentence.text, sr), sr).samples;
      const D = S.length / sr;
      // a word cannot be shorter than its letters take to say; engines that stretch the last word of a prefix
      // would otherwise squeeze the following word to a sliver
      const minDur = (w: string) => 0.05 + 0.025 * w.replace(/[^\p{L}\p{N}]/gu, '').length;
      const rough: number[] = [];
      for (let k = 0; k < toks.length - 1; k++) {
        if (timing === 'prefix') {
          rough.push(trimSilence(await synth(tts, toks.slice(0, k + 1).join(' '), sr), sr).samples.length / sr);
        } else {
          const weight = (w: string) => w.replace(/[^\p{L}\p{N}]/gu, '').length + 2;
          const total = toks.reduce((a, w) => a + weight(w), 0);
          rough.push((D * toks.slice(0, k + 1).reduce((a, w) => a + weight(w), 0)) / total);
        }
      }
      const floor = toks.map(minDur);
      const room = floor.reduce((a, b) => a + b, 0) <= D; // clip too short for the floors: skip them
      const ends: number[] = [];
      for (let k = 0; k < rough.length; k++) {
        const lo = room ? floor.slice(0, k + 1).reduce((a, b) => a + b, 0) : (ends[k - 1] ?? 0) + 0.02;
        const hi = room ? D - floor.slice(k + 1).reduce((a, b) => a + b, 0) : D;
        const e = Math.min(hi, Math.max(rough[k]!, lo, (ends[k - 1] ?? 0) + 0.02));
        ends.push(Math.min(hi, Math.max(snapToValley(S, sr, e), lo, (ends[k - 1] ?? 0) + 0.02)));
      }
      ends.push(D);
      const base = t;
      push(S);
      toks.forEach((w, k) => words.push({ text: w, start: base + (k === 0 ? 0 : ends[k - 1]!), end: base + ends[k]! }));
    }
    if (si < sentences.length - 1) silence(sentence.paragraphEnd ? Math.min(0.2, pause + 0.02) : pause);
  }
  opts.onProgress?.(sentences.length, sentences.length);

  const raw = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { raw.set(c, o); o += c.length; }

  // tight by construction: clamp any pause the engine itself introduced, and move the word times with the audio
  const clamped = clampSilences(raw, sr, { maxSilence: 0.2 });
  const aligned = remapAlignment(Alignment.parse({ words }), clamped.map, clamped.samples.length / sr);
  const duration = clamped.samples.length / sr;
  return { samples: clamped.samples, sampleRate: sr, alignment: Alignment.parse({ ...aligned, duration }), duration, sentences: sentences.length, timing };
}
