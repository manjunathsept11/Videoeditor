import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Alignment } from '@shortstudio/schema';
import { encodeWav16, speak, ttsFromName, type TimingMode } from '@shortstudio/audio';
import { ALIGNMENT, VOICEOVER } from './project';

export interface SpeakToProjectOptions {
  engine?: string;
  voice?: string;
  /** Engine-specific speed: words per minute for espeak/say, -10..10 for SAPI. */
  rate?: number;
  timing?: TimingMode;
  pause?: number;
}

/** Synthesize the script into `<dir>/audio/voiceover_tight.wav` with its `alignment.json`. */
export async function speakToProject(script: string, dir: string, o: SpeakToProjectOptions = {}): Promise<{ alignment: Alignment; duration: number; engine: string; timing: TimingMode }> {
  const tts = ttsFromName(o.engine ?? 'auto', { voice: o.voice, speed: o.rate });
  const r = await speak(script, tts, { timing: o.timing, pause: o.pause, onProgress: (d, n) => process.stdout.write(`\rspeaking ${d}/${n} sentences`) });
  process.stdout.write('\n');
  mkdirSync(join(dir, 'audio'), { recursive: true });
  writeFileSync(join(dir, VOICEOVER), encodeWav16(r.samples, r.sampleRate));
  writeFileSync(join(dir, ALIGNMENT), JSON.stringify(r.alignment, null, 2));
  return { alignment: r.alignment, duration: r.duration, engine: tts.name, timing: r.timing };
}
