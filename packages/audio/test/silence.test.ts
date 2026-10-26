import { describe, expect, it } from 'vitest';
import { clampSilences, mapTime } from '../src/silence';
import { encodeWav16 } from '../src/wav';
import { importWhisperJson, remapAlignment } from '../src/whisper';

const SR = 16000;

/** Sine bursts ("words") separated by exact silences. Returns samples + burst start times. */
function synth(parts: { silence: number; burst?: number }[]) {
  const total = parts.reduce((s, p) => s + p.silence + (p.burst ?? 0), 0);
  const x = new Float32Array(Math.round(total * SR));
  const starts: number[] = [];
  let t = 0;
  for (const p of parts) {
    t += p.silence;
    if (p.burst) {
      starts.push(t);
      for (let i = 0; i < p.burst * SR; i++) x[Math.round(t * SR) + i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
      t += p.burst;
    }
  }
  return { x, starts };
}

const firstLoud = (x: Float32Array, from = 0) => {
  for (let i = from; i < x.length; i++) if (Math.abs(x[i]!) > 0.1) return i / SR;
  return -1;
};

/** Longest run (seconds) of near-silent 10ms windows. */
function longestSilence(x: Float32Array) {
  const w = SR / 100;
  let run = 0, best = 0;
  for (let i = 0; i + w <= x.length; i += w) {
    let s = 0;
    for (let k = 0; k < w; k++) s += x[i + k]! ** 2;
    if (Math.sqrt(s / w) < 0.01) { run += 0.01; best = Math.max(best, run); } else run = 0;
  }
  return best;
}

const clip = () => synth([
  { silence: 0.5, burst: 0.3 },   // long leading silence
  { silence: 0.15, burst: 0.3 },  // short pause: must survive untouched
  { silence: 0.6, burst: 0.3 },   // long pause: clamp
  { silence: 1.0, burst: 0.3 },   // longer pause
  { silence: 0.5 },               // long trailing silence
]);

describe('clampSilences', () => {
  it('no pause longer than 0.2s survives (plus one analysis window of slack)', () => {
    const { x } = clip();
    const r = clampSilences(x, SR);
    expect(longestSilence(x)).toBeGreaterThan(0.9);
    expect(longestSilence(r.samples)).toBeLessThanOrEqual(0.2 + 0.011);
  });

  it('keeps the short pause exactly and removes exactly the excess', () => {
    const { x } = clip();
    const r = clampSilences(x, SR);
    // 0.5->0.2 (-0.3), 0.6->0.2 (-0.4), 1.0->0.2 (-0.8), trailing 0.5->0.2 (-0.3)
    expect(r.removed).toBeCloseTo(1.8, 2);
    expect(r.samples.length / SR).toBeCloseTo(x.length / SR - 1.8, 2);
  });

  it('does not alter speech: burst energy is preserved', () => {
    const { x } = clip();
    const r = clampSilences(x, SR);
    const energy = (a: Float32Array) => a.reduce((s, v) => s + v * v, 0);
    expect(energy(r.samples) / energy(x)).toBeGreaterThan(0.995);
  });

  it('mapTime lands every burst start on its true output position', () => {
    const { x, starts } = clip();
    const r = clampSilences(x, SR);
    let from = 0;
    for (const s of starts) {
      const outStart = firstLoud(r.samples, from);
      expect(mapTime(r.map, s)).toBeCloseTo(outStart, 1); // within one 10ms window + fade
      from = Math.round((outStart + 0.31) * SR); // step past the 0.3s burst
    }
  });

  it('is idempotent', () => {
    const { x } = clip();
    const once = clampSilences(x, SR);
    const twice = clampSilences(once.samples, SR);
    expect(twice.removed).toBeCloseTo(0, 3);
  });

  it('leaves audio with no long pauses untouched', () => {
    const { x } = synth([{ silence: 0.1, burst: 0.4 }, { silence: 0.15, burst: 0.4 }]);
    const r = clampSilences(x, SR);
    expect(r.removed).toBe(0);
    expect(r.samples.length).toBe(x.length);
  });

  it('honours a custom maxSilence', () => {
    const { x } = clip();
    const r = clampSilences(x, SR, { maxSilence: 0.1 });
    expect(longestSilence(r.samples)).toBeLessThanOrEqual(0.1 + 0.011);
  });
});

describe('encodeWav16', () => {
  it('writes a valid 44-byte header', () => {
    const b = encodeWav16(new Float32Array(100), SR);
    expect(b.toString('ascii', 0, 4)).toBe('RIFF');
    expect(b.toString('ascii', 8, 12)).toBe('WAVE');
    expect(b.readUInt32LE(24)).toBe(SR);
    expect(b.readUInt32LE(40)).toBe(200);
    expect(b.length).toBe(244);
  });
});

describe('importWhisperJson', () => {
  const whisperx = {
    segments: [{ words: [
      { word: 'Japan', start: 0.1, end: 0.5 },
      { word: 'moved', start: 0.5, end: 0.9 },
      { word: '3.4', },            // WhisperX leaves numbers untimed
      { word: 'trillion', },
      { word: 'yen', start: 1.7, end: 2.0 },
    ] }],
  };
  it('interpolates untimed words between timed neighbours', () => {
    const a = importWhisperJson(whisperx);
    expect(a.words.map((w) => w.text)).toEqual(['Japan', 'moved', '3.4', 'trillion', 'yen']);
    expect(a.words[2]!.start).toBeCloseTo(0.9, 9);
    expect(a.words[2]!.end).toBeCloseTo(1.3, 9);
    expect(a.words[3]!.end).toBeCloseTo(1.7, 9);
  });
  it('accepts word_segments and rejects empty input', () => {
    expect(importWhisperJson({ word_segments: [{ word: 'hi', start: 0, end: 0.2 }] }).words).toHaveLength(1);
    expect(() => importWhisperJson({ segments: [] })).toThrow(/no word timestamps/);
  });
  it('remaps an alignment made on original audio through the clamp', () => {
    const { x, starts } = clip();
    const r = clampSilences(x, SR);
    const a = importWhisperJson({ word_segments: starts.map((s, i) => ({ word: `w${i}`, start: s, end: s + 0.3 })) });
    const m = remapAlignment(a, r.map, r.samples.length / SR);
    m.words.forEach((w, i) => expect(w.start).toBeCloseTo(mapTime(r.map, starts[i]!), 9));
    expect(m.duration).toBeCloseTo(r.samples.length / SR, 9);
  });
});
