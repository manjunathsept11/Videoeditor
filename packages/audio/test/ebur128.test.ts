import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gainToDb, integratedLufs, truePeak } from '../src/loudness';
import { encodeWavStereo16 } from '../src/wav';

const SR = 48000;
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/** Speech-like test signal: a few formant-ish tones with syllable-rate amplitude modulation and noise, with pauses. */
function speechLike(secs: number, seed = 7): Float32Array {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const x = new Float32Array(Math.round(secs * SR));
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    const syll = Math.max(0, Math.sin(2 * Math.PI * 3.7 * t)) ** 2; // ~4 syllables/s
    const phrase = (t % 2.4) < 1.9 ? 1 : 0.02; // pauses between phrases
    const tone = Math.sin(2 * Math.PI * 140 * t) * 0.5 + Math.sin(2 * Math.PI * 700 * t) * 0.3 + Math.sin(2 * Math.PI * 1800 * t) * 0.15;
    x[i] = (tone + rnd() * 0.12) * syll * phrase * 0.35;
  }
  return x;
}

function ebur128(wavPath: string): { I: number; peak: number } {
  const r = spawnSync('ffmpeg', ['-nostats', '-i', wavPath, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' });
  const text = r.stderr;
  const summary = text.slice(text.lastIndexOf('Summary:'));
  const I = Number(/I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/.exec(summary)![1]);
  const peak = Number(/Peak:\s+(-?\d+(?:\.\d+)?)\s+dBFS/.exec(summary)![1]);
  return { I, peak };
}

describe.skipIf(!hasFfmpeg)('meter vs ffmpeg ebur128 (independent implementation)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lufs-'));

  for (const [name, gain] of [['quiet', 0.4], ['nominal', 1], ['hot', 2.2]] as const) {
    it(`integrated loudness and true peak agree on a ${name} stereo signal`, () => {
      const x = speechLike(12).map((v) => Math.max(-1, Math.min(1, v * gain)));
      const path = join(dir, `${name}.wav`);
      writeFileSync(path, encodeWavStereo16(x, x));
      const ref = ebur128(path);
      const mine = integratedLufs([x, x], SR);
      expect(Math.abs(mine - ref.I), `mine ${mine.toFixed(2)} vs ffmpeg ${ref.I}`).toBeLessThan(0.06); // exact ITU coefficients at 48 kHz
      expect(Math.abs(gainToDb(truePeak(x)) - ref.peak), `peak mine ${gainToDb(truePeak(x)).toFixed(2)} vs ffmpeg ${ref.peak}`).toBeLessThan(0.6);
    });
  }
});
