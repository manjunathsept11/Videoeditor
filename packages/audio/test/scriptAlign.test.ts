import { describe, expect, it } from 'vitest';
import { Alignment, resolveAnchor } from '@shortstudio/schema';
import { alignToScript } from '../src/scriptAlign';

/** Ground truth: the script's words every 0.4 s, 0.3 s long. The "recognizer" output is that, damaged in known ways. */
const SCRIPT = 'Gambling is rigged. The house always wins, and you know it.';
const WORDS = SCRIPT.split(/\s+/);
const truth = WORDS.map((text, i) => ({ text, start: i * 0.4, end: i * 0.4 + 0.3 }));
const heard = (words: { text: string; start: number; end: number }[], duration = 4.6): Alignment => Alignment.parse({ duration, words });

describe('alignToScript', () => {
  it('a perfect transcript returns the same times, spelled like the script', () => {
    const r = alignToScript(heard(truth.map((w) => ({ ...w, text: w.text.toLowerCase().replace(/[.,]/g, '') }))), SCRIPT);
    expect(r.alignment.words.map((w) => w.text)).toEqual(WORDS);
    expect(r.alignment.words.map((w) => [w.start, w.end])).toEqual(truth.map((w) => [w.start, w.end]));
    expect(r.matched).toBe(WORDS.length);
    expect(r.exact).toBe(WORDS.length);
    expect(r.interpolated + r.extras).toBe(0);
  });

  it('misspellings still match and keep their own times', () => {
    const damaged = truth.map((w) => ({ ...w }));
    damaged[0]!.text = 'gambing';
    damaged[3]!.text = 'da';
    damaged[5]!.text = 'always,';
    damaged[9]!.text = 'no';
    const r = alignToScript(heard(damaged), SCRIPT);
    expect(r.alignment.words[0]).toMatchObject({ text: 'Gambling', start: 0, end: 0.3 });
    expect(r.matched).toBe(WORDS.length - 1); // 'da' is too far from 'The' and is interpolated instead
    expect(r.interpolated).toBe(1);
    expect(r.alignment.words[3]!.start).toBeGreaterThanOrEqual(truth[2]!.end - 1e-9);
    expect(r.alignment.words[3]!.end).toBeLessThanOrEqual(truth[4]!.start + 1e-9);
    expect(r.alignment.words[5]).toMatchObject({ start: 5 * 0.4, end: 5 * 0.4 + 0.3 });
  });

  it('words the recognizer dropped are interpolated between their neighbours', () => {
    const dropped = truth.filter((_, i) => i !== 3 && i !== 4);
    const r = alignToScript(heard(dropped), SCRIPT);
    expect(r.interpolated).toBe(2);
    const w = r.alignment.words;
    expect(w[3]!.start).toBeCloseTo(w[2]!.end, 6);
    expect(w[4]!.end).toBeCloseTo(w[5]!.start, 6);
    expect(w[3]!.end).toBeCloseTo(w[4]!.start, 6);
    expect(w[3]!.start).toBeGreaterThanOrEqual(truth[2]!.end - 1e-9);
    expect(w[4]!.end).toBeLessThanOrEqual(truth[5]!.start + 1e-9);
    // the word after the hole still has its true time
    expect(w[5]).toMatchObject({ start: truth[5]!.start, end: truth[5]!.end });
  });

  it('extra words the recognizer invented are ignored', () => {
    const extra = [...truth.slice(0, 4), { text: 'uh', start: 1.52, end: 1.54 }, { text: 'like', start: 1.55, end: 1.58 }, ...truth.slice(4)];
    const r = alignToScript(heard(extra), SCRIPT);
    expect(r.extras).toBe(2);
    expect(r.matched).toBe(WORDS.length);
    expect(r.alignment.words.map((w) => w.text)).toEqual(WORDS);
    expect(r.alignment.words[4]).toMatchObject({ start: truth[4]!.start });
  });

  it('missing start and missing end are filled from the duration and zero', () => {
    const r = alignToScript(heard(truth.slice(2, WORDS.length - 2), 5), SCRIPT);
    const w = r.alignment.words;
    expect(w[0]!.start).toBe(0);
    expect(w[1]!.end).toBeLessThanOrEqual(truth[2]!.start + 1e-9);
    expect(w[w.length - 1]!.end).toBeLessThanOrEqual(5);
    expect(w[w.length - 2]!.start).toBeGreaterThanOrEqual(truth[WORDS.length - 3]!.end - 1e-9);
    Alignment.parse(r.alignment); // monotone, valid
  });

  it('numbers and symbols the script spells differently are matched or interpolated, never lost', () => {
    const script = 'It costs $5 per day.';
    const r = alignToScript(heard([
      { text: 'it', start: 0, end: 0.2 }, { text: 'costs', start: 0.2, end: 0.6 },
      { text: 'per', start: 1.0, end: 1.2 }, { text: 'day', start: 1.2, end: 1.5 },
    ], 1.6), script);
    expect(r.alignment.words.map((w) => w.text)).toEqual(['It', 'costs', '$5', 'per', 'day.']);
    expect(r.interpolated).toBe(1);
    expect(r.alignment.words[2]!.start).toBeCloseTo(0.6, 6);
    expect(r.alignment.words[2]!.end).toBeCloseTo(1.0, 6);
  });

  it('anchors written against the script resolve on the result', () => {
    const r = alignToScript(heard(truth.map((w) => ({ ...w, text: w.text.toLowerCase() }))), SCRIPT);
    expect(resolveAnchor(r.alignment, { word: 'house', nth: 1, edge: 'start', offset: 0 })).toBeCloseTo(4 * 0.4, 6);
  });

  it('rejects empty inputs', () => {
    expect(() => alignToScript(heard(truth), '  ')).toThrow(/no words/);
    expect(() => alignToScript(Alignment.parse({ words: [] }), SCRIPT)).toThrow(/heard no words/);
  });
});
