import { Alignment } from '@shortstudio/schema';
import { mapTime, type Segment } from './silence';

interface RawWord { word?: string; text?: string; start?: number; end?: number }

/**
 * Import word timestamps from WhisperX or openai-whisper / whisper-timestamped JSON
 * (`segments[].words[]` or `word_segments[]`). Words the aligner could not time
 * (WhisperX leaves numbers and symbols untimed) are spread evenly between their
 * timed neighbours, so nothing is silently dropped.
 */
export function importWhisperJson(json: unknown, duration?: number): Alignment {
  const j = json as { segments?: { words?: RawWord[] }[]; word_segments?: RawWord[] };
  const raw: RawWord[] = j.word_segments ?? (j.segments ?? []).flatMap((s) => s.words ?? []);
  if (raw.length === 0) throw new Error('no word timestamps found: expected segments[].words[] or word_segments[]');

  const words = raw.map((w) => ({ text: (w.word ?? w.text ?? '').trim(), start: w.start, end: w.end }));
  for (let i = 0; i < words.length; ) {
    if (words[i]!.start !== undefined && words[i]!.end !== undefined) { i++; continue; }
    let j = i;
    while (j < words.length && (words[j]!.start === undefined || words[j]!.end === undefined)) j++;
    const from = i > 0 ? words[i - 1]!.end! : (words[j]?.start ?? 0);
    const to = j < words.length ? words[j]!.start! : from;
    const step = (to - from) / (j - i);
    for (let k = i; k < j; k++) {
      words[k]!.start = from + step * (k - i);
      words[k]!.end = from + step * (k - i + 1);
    }
    i = j;
  }
  return Alignment.parse({ version: 1, duration, words: words.filter((w) => w.text) });
}

/** Re-time an alignment made on the original audio so it matches the tightened audio. */
export function remapAlignment(a: Alignment, map: readonly Segment[], tightDuration?: number): Alignment {
  return {
    ...a,
    duration: tightDuration ?? a.duration,
    words: a.words.map((w) => ({ text: w.text, start: mapTime(map, w.start), end: mapTime(map, w.end) })),
  };
}
