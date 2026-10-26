import { Alignment, normalizeToken } from '@shortstudio/schema';

export interface ScriptAlignment {
  /** One entry per word of the script (spelled as the script spells it), timed from the recording. */
  alignment: Alignment;
  /** Script words that got a recognized word's time (exact or fuzzy). */
  matched: number;
  /** Script words the recognizer missed, timed by spreading them between their neighbours. */
  interpolated: number;
  /** Recognized words that are not in the script (ad-libs, stutters, hallucinations) and were ignored. */
  extras: number;
  /** Script words recognized with exactly the right letters. */
  exact: number;
}

const key = (text: string) => normalizeToken(text).join('');
const letters = (w: string) => Math.max(1, key(w).length);

/** 1 for identical, falling towards 0 with edit distance. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const n = Math.max(a.length, b.length);
  if (n === 0) return 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length]! / n;
}

/**
 * Give a script its timings from a speech recognizer's output. The recognizer hears what was said, with errors; the
 * script is what was meant. Needleman-Wunsch aligns the two word sequences (near-misses like "gambing" for "gambling"
 * still match), the script's words take the matched words' times, words the recognizer dropped are interpolated, and
 * words it invented are ignored. The result is spelled exactly like the script, so anchors in a project written from the
 * script always resolve.
 */
export function alignToScript(heard: Alignment, script: string): ScriptAlignment {
  const want = script.split(/\s+/).filter((w) => key(w));
  if (want.length === 0) throw new Error('the script has no words');
  const got = heard.words.filter((w) => key(w.text));
  if (got.length === 0) throw new Error('the recognizer heard no words');
  const n = want.length, m = got.length;

  const GAP = -1;
  const score = (i: number, j: number) => {
    const s = similarity(key(want[i]!), key(got[j]!.text));
    return s === 1 ? 2 : s >= 0.5 ? 2 * s - 0.5 : -1.5;
  };
  const H = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const from = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 0 diag, 1 up (script word unmatched), 2 left (extra)
  for (let i = 1; i <= n; i++) { H[i]![0] = i * GAP; from[i]![0] = 1; }
  for (let j = 1; j <= m; j++) { H[0]![j] = j * GAP; from[0]![j] = 2; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const d = H[i - 1]![j - 1]! + score(i - 1, j - 1);
      const u = H[i - 1]![j]! + GAP;
      const l = H[i]![j - 1]! + GAP;
      if (d >= u && d >= l) { H[i]![j] = d; from[i]![j] = 0; }
      else if (u >= l) { H[i]![j] = u; from[i]![j] = 1; }
      else { H[i]![j] = l; from[i]![j] = 2; }
    }
  }

  // trace back; a "diagonal" step on dissimilar words is two gaps in disguise, so it is not a match
  const hit: (number | undefined)[] = new Array(n).fill(undefined);
  let extras = 0;
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const f = from[i]![j]!;
    if (f === 0) {
      if (similarity(key(want[i - 1]!), key(got[j - 1]!.text)) >= 0.5) hit[i - 1] = j - 1;
      else extras++;
      i--; j--;
    } else if (f === 1) i--;
    else { extras++; j--; }
  }

  const times: { start: number; end: number }[] = new Array(n);
  let matched = 0, exact = 0;
  hit.forEach((j, i) => {
    if (j === undefined) return;
    times[i] = { start: got[j]!.start, end: got[j]!.end };
    matched++;
    if (key(want[i]!) === key(got[j]!.text)) exact++;
  });

  // spread each run of unmatched words over the gap between their timed neighbours, by letter count
  const total = heard.duration ?? got[got.length - 1]!.end;
  let interpolated = 0;
  for (let i = 0; i < n; ) {
    if (times[i]) { i++; continue; }
    let k = i;
    while (k < n && !times[k]) k++;
    const t0 = i > 0 ? times[i - 1]!.end : 0;
    const t1 = k < n ? Math.max(t0, times[k]!.start) : Math.max(t0, total);
    const weights = want.slice(i, k).map(letters);
    const sum = weights.reduce((a, b) => a + b, 0);
    let t = t0;
    for (let q = i; q < k; q++) {
      const end = t + ((t1 - t0) * weights[q - i]!) / sum;
      times[q] = { start: t, end };
      t = end;
    }
    interpolated += k - i;
    i = k;
  }

  const words = want.map((text, i) => ({ text, start: times[i]!.start, end: times[i]!.end }));
  // recognizers occasionally overlap neighbouring words by a hair; the schema wants starts in order
  for (let i = 1; i < words.length; i++) {
    if (words[i]!.start < words[i - 1]!.start) words[i]!.start = words[i - 1]!.start;
    if (words[i]!.end < words[i]!.start) words[i]!.end = words[i]!.start;
  }
  return { alignment: Alignment.parse({ version: 1, duration: heard.duration, words }), matched, interpolated, extras, exact };
}
