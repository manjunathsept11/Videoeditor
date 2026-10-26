/**
 * ITU-R BS.1770-4 loudness: K-weighting, 400 ms blocks at 75% overlap, absolute (-70 LUFS) and relative (-10 LU) gates.
 * Channel energies are summed, so a dual-mono stereo file reads 3.01 LU louder than the same signal as mono, exactly
 * as a meter reads it. The mixer targets stereo output, so it always measures `[x, x]`.
 */

interface Biquad {
  b: [number, number, number];
  a: [number, number]; // a1, a2 (a0 normalised to 1)
}

/**
 * The exact coefficients published in ITU-R BS.1770-4 for 48 kHz: these agree with ffmpeg's ebur128 to ~0.04 LU.
 * Other rates use the derived design below, which is only good to about 0.3 LU; the whole pipeline decodes to 48 kHz
 * so it is rarely used. Resample to 48 kHz first if you need exact numbers at another rate.
 */
const ITU_48K: { shelf: Biquad; highpass: Biquad } = {
  shelf: { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] },
  highpass: { b: [1.0, -2.0, 1.0], a: [-1.99004745483398, 0.99007225036621] },
};

/** K-weighting stage 1: high shelf (+4 dB above ~1.7 kHz). RBJ design, as used by pyloudnorm. */
function shelf(fs: number): Biquad {
  if (fs === 48000) return ITU_48K.shelf;
  const G = 3.999843853973347, Q = 0.7071752369554196, fc = 1681.9744509555319;
  const A = 10 ** (G / 40), w0 = (2 * Math.PI * fc) / fs, alpha = Math.sin(w0) / (2 * Q), c = Math.cos(w0), sA = 2 * Math.sqrt(A) * alpha;
  const a0 = A + 1 - (A - 1) * c + sA;
  return {
    b: [(A * (A + 1 + (A - 1) * c + sA)) / a0, (-2 * A * (A - 1 + (A + 1) * c)) / a0, (A * (A + 1 + (A - 1) * c - sA)) / a0],
    a: [(2 * (A - 1 - (A + 1) * c)) / a0, (A + 1 - (A - 1) * c - sA) / a0],
  };
}

/** K-weighting stage 2: high-pass at ~38 Hz. */
function highpass(fs: number): Biquad {
  if (fs === 48000) return ITU_48K.highpass;
  const Q = 0.5003270373253953, fc = 38.13547087613982;
  const w0 = (2 * Math.PI * fc) / fs, alpha = Math.sin(w0) / (2 * Q), c = Math.cos(w0);
  const a0 = 1 + alpha;
  return { b: [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0], a: [(-2 * c) / a0, (1 - alpha) / a0] };
}

function filter(x: Float32Array, f: Biquad): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = f.b[0] * x[i]! + f.b[1] * x1 + f.b[2] * x2 - f.a[0] * y1 - f.a[1] * y2;
    y[i] = v;
    x2 = x1; x1 = x[i]!; y2 = y1; y1 = v;
  }
  return y;
}

export const kWeight = (x: Float32Array, fs: number): Float32Array => filter(filter(x, shelf(fs)), highpass(fs));

const toLufs = (meanSquare: number) => -0.691 + 10 * Math.log10(meanSquare);

/** Per-block summed mean squares of the K-weighted channels (400 ms blocks, 100 ms hop). */
function blockEnergies(channels: Float32Array[], fs: number): number[] {
  const w = channels.map((c) => kWeight(c, fs));
  const len = w[0]!.length;
  const block = Math.round(0.4 * fs), hop = Math.round(0.1 * fs);
  if (len < block) return [];
  // prefix sums of squared samples per channel for O(1) block means
  const pre = w.map((c) => {
    const p = new Float64Array(len + 1);
    for (let i = 0; i < len; i++) p[i + 1] = p[i]! + c[i]! * c[i]!;
    return p;
  });
  const out: number[] = [];
  for (let s = 0; s + block <= len; s += hop) out.push(pre.reduce((sum, p) => sum + (p[s + block]! - p[s]!) / block, 0));
  return out;
}

/** Gated integrated loudness in LUFS. -Infinity for silence. Sub-400 ms signals fall back to ungated. */
export function integratedLufs(channels: Float32Array[], fs: number): number {
  const blocks = blockEnergies(channels, fs);
  if (blocks.length === 0) return ungatedLufs(channels, fs);
  const abs = blocks.filter((z) => toLufs(z) > -70);
  if (abs.length === 0) return -Infinity;
  const relGate = toLufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const kept = abs.filter((z) => toLufs(z) > relGate);
  if (kept.length === 0) return -Infinity;
  return toLufs(kept.reduce((a, b) => a + b, 0) / kept.length);
}

/** Loudness of the whole signal with no gating: the right measure for a single short sound effect. */
export function ungatedLufs(channels: Float32Array[], fs: number): number {
  const w = channels.map((c) => kWeight(c, fs));
  let sum = 0;
  for (const c of w) {
    let s = 0;
    for (let i = 0; i < c.length; i++) s += c[i]! * c[i]!;
    sum += s / Math.max(1, c.length);
  }
  return sum === 0 ? -Infinity : toLufs(sum);
}

export const dbToGain = (db: number) => 10 ** (db / 20);
export const gainToDb = (g: number) => 20 * Math.log10(g);

// ---------------------------------------------------------------- peaks

export function samplePeak(x: Float32Array): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]!));
  return p;
}

const TP_TAPS = 32; // 12 taps under-read sharp transients by ~0.2 dB against ffmpeg's ebur128; 32 agrees to ~0.02
const TP_FIR: number[][] = Array.from({ length: 4 }, (_, phase) =>
  Array.from({ length: TP_TAPS }, (_, k) => {
    const x = k - (TP_TAPS / 2 - 1) - phase / 4; // fractional position of the interpolated sample
    const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const hann = 0.5 * (1 + Math.cos((Math.PI * x) / (TP_TAPS / 2)));
    return sinc * hann;
  }),
);

/** True peak (linear) estimated from 4x oversampling, as BS.1770 Annex 2 describes. */
export function truePeak(x: Float32Array): number {
  let peak = samplePeak(x);
  for (let i = 0; i < x.length; i++) {
    // an inter-sample overshoot needs neighbours already near the peak; skip the filter where both are far below it
    if (Math.max(Math.abs(x[i]!), Math.abs(x[i + 1] ?? 0)) < 0.3 * peak) continue;
    for (let ph = 1; ph < 4; ph++) {
      let v = 0;
      for (let k = 0; k < TP_TAPS; k++) {
        const j = i + k - (TP_TAPS / 2 - 1);
        if (j >= 0 && j < x.length) v += x[j]! * TP_FIR[ph]![k]!;
      }
      peak = Math.max(peak, Math.abs(v));
    }
  }
  return peak;
}

/**
 * Lookahead peak limiter (offline). The gain needed at each sample is spread over +-5 ms by a sliding minimum
 * and then a moving average, so the gain is always at or below what each peak needs and never steps.
 */
export function limit(x: Float32Array, ceiling: number, fs: number, lookaheadMs = 5): Float32Array {
  const n = x.length;
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.abs(x[i]!);
    need[i] = a > ceiling ? ceiling / a : 1;
  }
  const N = Math.max(1, Math.round((lookaheadMs / 1000) * fs));
  // sliding minimum over [i-N, i+N] (monotonic deque)
  const mins = new Float32Array(n);
  const dq: number[] = [];
  let head = 0;
  for (let i = 0, j = 0; i < n; i++) {
    for (; j <= Math.min(n - 1, i + N); j++) {
      while (dq.length > head && need[dq[dq.length - 1]!]! >= need[j]!) dq.pop();
      dq.push(j);
    }
    while (dq[head]! < i - N) head++;
    mins[i] = need[dq[head]!]!;
  }
  // moving average over [i-N, i+N]
  const out = new Float32Array(n);
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i]! + mins[i]!;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - N), hi = Math.min(n - 1, i + N);
    out[i] = x[i]! * ((pre[hi + 1]! - pre[lo]!) / (hi - lo + 1));
  }
  return out;
}
