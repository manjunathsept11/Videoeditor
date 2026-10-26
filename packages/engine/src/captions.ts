import type { Alignment } from '@shortstudio/schema';

export interface CaptionWord {
  text: string;
  start: number;
  end: number;
}

export interface CaptionLine {
  text: string;
  words: CaptionWord[];
  /** On screen from here... */
  start: number;
  /** ...until here (a short hold after the last word, never overlapping the next line). */
  end: number;
}

export interface CaptionOptions {
  maxWords?: number;
  maxChars?: number;
  /** A pause longer than this starts a new line. */
  maxGap?: number;
  /** How long a line lingers after its last word. */
  hold?: number;
}

const SENTENCE_END = /[.!?。！？…]["')\]]*$/;

/** Group aligned words into short caption lines: few words, break on sentence ends and pauses. Pure. */
export function buildCaptionLines(alignment: Alignment, opts: CaptionOptions = {}): CaptionLine[] {
  const { maxWords = 3, maxChars = 22, maxGap = 0.6, hold = 0.15 } = opts;
  const lines: CaptionLine[] = [];
  let cur: CaptionWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    lines.push({ text: cur.map((w) => w.text).join(' '), words: cur, start: cur[0]!.start, end: cur[cur.length - 1]!.end + hold });
    cur = [];
  };
  for (const w of alignment.words) {
    const word = { text: w.text.trim(), start: w.start, end: w.end };
    if (!word.text) continue;
    const prev = cur[cur.length - 1];
    const chars = cur.reduce((n, x) => n + x.text.length + 1, 0) + word.text.length;
    if (prev && (cur.length >= maxWords || chars > maxChars || word.start - prev.end > maxGap)) flush();
    cur.push(word);
    if (SENTENCE_END.test(word.text)) flush();
  }
  flush();
  for (let i = 0; i + 1 < lines.length; i++) lines[i]!.end = Math.min(lines[i]!.end, lines[i + 1]!.start);
  return lines;
}

export interface ActiveCaption {
  line: CaptionLine;
  /** Index of the word being spoken (the last one that has started). */
  word: number;
}

export function captionAt(lines: readonly CaptionLine[], t: number): ActiveCaption | null {
  for (const line of lines) {
    if (t >= line.start && t < line.end) {
      let word = 0;
      line.words.forEach((w, i) => {
        if (w.start <= t) word = i;
      });
      return { line, word };
    }
  }
  return null;
}
