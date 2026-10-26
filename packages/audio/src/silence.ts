/**
 * Silence clamping: no pause in the voiceover may exceed `maxSilence` seconds.
 * Pure DSP over mono float samples, so it is testable without any audio files.
 */
export interface SilenceOpts {
  /** RMS below this (dBFS) counts as silence. */
  thresholdDb?: number;
  /** Longest pause allowed in the output, seconds. */
  maxSilence?: number;
  /** Analysis window, seconds. */
  window?: number;
}

/** One kept stretch of the source, and where it lands in the output (seconds). */
export interface Segment {
  srcStart: number;
  srcEnd: number;
  dstStart: number;
}

export interface ClampResult {
  samples: Float32Array;
  map: Segment[];
  /** Seconds removed. */
  removed: number;
}

const FADE_SECONDS = 0.002;

export function clampSilences(input: Float32Array, sampleRate: number, opts: SilenceOpts = {}): ClampResult {
  const { thresholdDb = -40, maxSilence = 0.2, window = 0.01 } = opts;
  const win = Math.max(1, Math.round(window * sampleRate));
  const maxLen = Math.round(maxSilence * sampleRate);
  const thr = 10 ** (thresholdDb / 20);
  const n = input.length;

  // silent runs as [a, b) in samples
  const runs: [number, number][] = [];
  let runStart = -1;
  for (let i = 0; i < n; i += win) {
    const end = Math.min(n, i + win);
    let sum = 0;
    for (let k = i; k < end; k++) sum += input[k]! * input[k]!;
    const silent = Math.sqrt(sum / (end - i)) < thr;
    if (silent && runStart < 0) runStart = i;
    if (!silent && runStart >= 0) { runs.push([runStart, i]); runStart = -1; }
  }
  if (runStart >= 0) runs.push([runStart, n]);

  // kept stretches: drop the middle of any run longer than maxLen
  const kept: [number, number][] = [];
  let cursor = 0;
  for (const [a, b] of runs) {
    if (b - a <= maxLen) continue;
    const leading = a === 0;
    const trailing = b === n;
    const head = leading ? 0 : trailing ? maxLen : Math.floor(maxLen / 2);
    const tail = leading ? maxLen : trailing ? 0 : maxLen - head;
    const cutFrom = a + head;
    const cutTo = b - tail;
    if (cutFrom > cursor) kept.push([cursor, cutFrom]);
    cursor = cutTo;
  }
  if (cursor < n) kept.push([cursor, n]);

  const total = kept.reduce((s, [a, b]) => s + (b - a), 0);
  const out = new Float32Array(total);
  const map: Segment[] = [];
  const fade = Math.round(FADE_SECONDS * sampleRate);
  let dst = 0;
  kept.forEach(([a, b], idx) => {
    out.set(input.subarray(a, b), dst);
    map.push({ srcStart: a / sampleRate, srcEnd: b / sampleRate, dstStart: dst / sampleRate });
    const len = b - a;
    if (idx > 0) for (let k = 0; k < Math.min(fade, len); k++) out[dst + k]! *= k / fade; // fade in after a cut
    if (idx < kept.length - 1) for (let k = 0; k < Math.min(fade, len); k++) out[dst + len - 1 - k]! *= k / fade; // fade out before a cut
    dst += len;
  });
  return { samples: out, map, removed: (n - total) / sampleRate };
}

/** Source time -> output time. A time inside a removed gap snaps to the cut. */
export function mapTime(map: readonly Segment[], t: number): number {
  if (map.length === 0) return t;
  for (let i = 0; i < map.length; i++) {
    const s = map[i]!;
    if (t < s.srcStart) return s.dstStart; // inside the gap before this segment
    if (t < s.srcEnd) return s.dstStart + (t - s.srcStart);
  }
  const last = map[map.length - 1]!;
  return last.dstStart + (last.srcEnd - last.srcStart);
}
