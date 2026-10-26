import { describe, expect, it } from 'vitest';
import { dbToGain, gainToDb, integratedLufs, limit, samplePeak, truePeak, ungatedLufs } from '../src/loudness';

const SR = 48000;
const sine = (hz: number, secs: number, amp: number, sr = SR) => Float32Array.from({ length: Math.round(secs * sr) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sr));

describe('BS.1770 loudness', () => {
  it('a full-scale 997 Hz sine reads about -3.01 LUFS mono-in-one-channel (the standard calibration)', () => {
    // 0 dBFS sine on one channel: mean square 0.5, K-weighting ~0 dB at 1 kHz -> -0.691 + 10log10(0.5) = -3.70... plus shelf gain ~ +0.69
    const l = integratedLufs([sine(997, 5, 1)], SR);
    expect(l).toBeGreaterThan(-3.4);
    expect(l).toBeLessThan(-2.8);
  });
  it('dual mono reads 3.01 LU louder than mono', () => {
    const x = sine(1000, 4, 0.1);
    expect(integratedLufs([x, x], SR) - integratedLufs([x], SR)).toBeCloseTo(3.0103, 2);
  });
  it('is linear in level: +6 dB of gain reads +6 LU', () => {
    const x = sine(500, 4, 0.05);
    const y = x.map((v) => v * dbToGain(6));
    expect(integratedLufs([y], SR) - integratedLufs([x], SR)).toBeCloseTo(6, 2);
    expect(gainToDb(dbToGain(-14))).toBeCloseTo(-14, 9);
  });
  it('K-weighting: low frequencies count less than mids at the same amplitude', () => {
    expect(integratedLufs([sine(50, 4, 0.1)], SR)).toBeLessThan(integratedLufs([sine(1000, 4, 0.1)], SR) - 1);
  });
  it('the relative gate ignores quiet passages, so a long silence does not drag the reading down', () => {
    const loud = sine(1000, 3, 0.2);
    const quiet = sine(1000, 6, 0.0005);
    const both = new Float32Array(loud.length + quiet.length);
    both.set(loud);
    both.set(quiet, loud.length);
    const gated = integratedLufs([both], SR);
    expect(Math.abs(gated - integratedLufs([loud], SR))).toBeLessThan(0.5); // boundary blocks pull it ~0.2 LU, no more
    expect(ungatedLufs([loud], SR) - ungatedLufs([both], SR)).toBeGreaterThan(3); // without the gate the silence would cost >3 LU
  });
  it('silence is -Infinity, and a signal shorter than one block falls back to ungated', () => {
    expect(integratedLufs([new Float32Array(SR * 2)], SR)).toBe(-Infinity);
    const blip = sine(1000, 0.2, 0.3);
    expect(integratedLufs([blip], SR)).toBeCloseTo(ungatedLufs([blip], SR), 9);
  });
  it('other sample rates use a derived filter that is only good to ~0.3 LU (48 kHz is exact)', () => {
    const a = integratedLufs([sine(1000, 4, 0.1, 44100)], 44100);
    const b = integratedLufs([sine(1000, 4, 0.1, 48000)], 48000);
    expect(Math.abs(a - b)).toBeLessThan(0.4);
  });
});

describe('peaks and limiting', () => {
  it('true peak sees an inter-sample overshoot the sample peak misses', () => {
    // a sine at fs/4 sampled 45 degrees off its crest: every sample reads 0.707 but the waveform peaks at 1.0
    const x = Float32Array.from({ length: 4800 }, (_, i) => Math.sin((Math.PI / 2) * i + Math.PI / 4));
    expect(samplePeak(x)).toBeCloseTo(Math.SQRT1_2, 3);
    expect(truePeak(x)).toBeGreaterThan(0.97);
    expect(truePeak(x)).toBeLessThan(1.03);
  });
  it('the limiter holds the ceiling on a hot signal and leaves quiet audio untouched', () => {
    const hot = sine(300, 1, 1.8);
    const out = limit(hot, 0.89, SR);
    expect(samplePeak(out)).toBeLessThanOrEqual(0.89 + 1e-6);
    const quiet = sine(300, 1, 0.3);
    const same = limit(quiet, 0.89, SR);
    for (let i = 0; i < quiet.length; i += 997) expect(same[i]).toBeCloseTo(quiet[i]!, 6);
  });
  it('limiting never steps: the gain changes smoothly around a single loud click', () => {
    const x = new Float32Array(SR / 2).fill(0.1);
    x[SR / 4] = 3;
    const out = limit(x, 0.9, SR);
    let maxStep = 0;
    for (let i = 1; i < x.length; i++) maxStep = Math.max(maxStep, Math.abs(out[i]! / (x[i] === 3 ? 3 : 0.1) - out[i - 1]! / (x[i - 1] === 3 ? 3 : 0.1)));
    expect(samplePeak(out)).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(maxStep).toBeLessThan(0.05);
  });
});
