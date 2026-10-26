/**
 * Sound effects synthesized from scratch: deterministic (seeded noise), royalty-free, and exactly repeatable.
 * Every function returns mono float samples normalised to a peak of 1; the mixer sets the level.
 */
import { SAMPLE_RATE } from './wav';

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

const normalise = (x: Float32Array): Float32Array => {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]!));
  if (p > 0) for (let i = 0; i < x.length; i++) x[i]! /= p;
  return x;
};

const onePoleLP = (x: Float32Array, fc: number, sr: number): Float32Array => {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / sr);
  const y = new Float32Array(x.length);
  let s = 0;
  for (let i = 0; i < x.length; i++) y[i] = s += a * (x[i]! - s);
  return y;
};

/** Low thump with a noise body and a short click: boxes landing, fists on tables, a jolt. */
export function impact(sr = SAMPLE_RATE): Float32Array {
  const n = Math.round(0.5 * sr);
  const r = prng(11);
  const noise = onePoleLP(Float32Array.from({ length: n }, () => r()), 500, sr);
  const x = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    phase += (2 * Math.PI * (42 + 95 * Math.exp(-t / 0.045))) / sr;
    x[i] = Math.sin(phase) * Math.exp(-t / 0.13) + noise[i]! * 1.6 * Math.exp(-t / 0.05) + r() * 0.5 * Math.exp(-t / 0.004);
  }
  return normalise(x);
}

/** Band-passed noise sweeping upward under a smooth hump: a camera move, a swish, a transition. */
export function whoosh(sr = SAMPLE_RATE, seconds = 0.55): Float32Array {
  const n = Math.round(seconds * sr);
  const r = prng(23);
  const x = new Float32Array(n);
  let low = 0, band = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const fc = 350 * Math.pow(3200 / 350, u); // exponential sweep up
    const f = 2 * Math.sin((Math.PI * fc) / sr);
    const q = 0.9;
    const high = r() - low - q * band;
    band += f * high;
    low += f * band;
    x[i] = band * Math.sin(Math.PI * u) ** 1.6;
  }
  return normalise(x);
}

/** A crisp click with a short pitched blip: counters landing, switches. */
export function tick(sr = SAMPLE_RATE): Float32Array {
  const n = Math.round(0.09 * sr);
  const r = prng(31);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    x[i] = Math.sin(2 * Math.PI * 2200 * t) * Math.exp(-t / 0.012) + r() * 0.7 * Math.exp(-t / 0.003);
  }
  return normalise(x);
}

/** A small bell: dials locking into place, a clock chiming. */
export function ding(sr = SAMPLE_RATE): Float32Array {
  const n = Math.round(0.9 * sr);
  const x = new Float32Array(n);
  const partials: [number, number, number][] = [[880, 1, 0.5], [880 * 2.76, 0.5, 0.22], [880 * 5.4, 0.25, 0.1]];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = 0;
    for (const [f, a, tau] of partials) v += a * Math.sin(2 * Math.PI * f * t) * Math.exp(-t / tau);
    x[i] = v * Math.min(1, t / 0.002); // 2 ms attack avoids a click
  }
  return normalise(x);
}

/** Paper riffle: three quick bursts of high-passed noise. Calendar pages. */
export function pageflip(sr = SAMPLE_RATE): Float32Array {
  const n = Math.round(0.34 * sr);
  const r = prng(41);
  const lp = onePoleLP(Float32Array.from({ length: n }, () => r()), 600, sr);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const hp = (r() - lp[i]!) * 0.9; // noise minus its lows
    const bursts = [0.01, 0.1, 0.19].reduce((a, t0) => a + (t >= t0 ? Math.exp(-(t - t0) / 0.035) : 0), 0);
    x[i] = hp * bursts;
  }
  return normalise(x);
}

/** One footfall: a soft low thud and a little scuff. */
export function step(sr = SAMPLE_RATE, variant = 0): Float32Array {
  const n = Math.round(0.14 * sr);
  const r = prng(53 + variant * 7);
  const scuff = onePoleLP(Float32Array.from({ length: n }, () => r()), 1800, sr);
  const f = 62 + (variant % 2) * 9;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    x[i] = Math.sin(2 * Math.PI * f * t) * Math.exp(-t / 0.035) + scuff[i]! * 0.9 * Math.exp(-t / 0.012);
  }
  return normalise(x);
}

export type SynthKind = 'impact' | 'whoosh' | 'tick' | 'ding' | 'pageflip' | 'steps';

/** The sample for a cue kind. `steps` is a single footfall; the mixer repeats it at each offset. */
export function synthesize(kind: SynthKind, sr = SAMPLE_RATE, variant = 0): Float32Array {
  switch (kind) {
    case 'impact': return impact(sr);
    case 'whoosh': return whoosh(sr);
    case 'tick': return tick(sr);
    case 'ding': return ding(sr);
    case 'pageflip': return pageflip(sr);
    case 'steps': return step(sr, variant);
  }
}
