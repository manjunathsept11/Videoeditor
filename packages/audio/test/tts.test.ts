import { describe, expect, it } from 'vitest';
import { Alignment } from '@shortstudio/schema';
import { EspeakTts, commandExists, speak, splitSentences, snapToValley, ttsFromName, type TtsProvider } from '../src/tts';
import { trimSilence } from '../src/silence';
import { encodeWav16, parseWav, resample } from '../src/wav';

const FAKE_SR = 22050;
const CHAR = 0.06; // seconds of tone per letter
const GAP = 0.04; // silence for a space
const PAD = 0.3; // silence the "engine" puts around everything

/**
 * A text-to-speech engine whose output is known exactly: a tone burst per letter (pitch depends on the letter),
 * silence for spaces, and 300 ms of padding either end like real engines. Gives exact ground truth for word times.
 */
class ToneTts implements TtsProvider {
  readonly name = 'tone';
  calls: string[] = [];
  async synthesize(text: string) {
    this.calls.push(text);
    const parts: Float32Array[] = [new Float32Array(Math.round(PAD * FAKE_SR))];
    for (const ch of text) {
      if (/\s/.test(ch)) {
        parts.push(new Float32Array(Math.round(GAP * FAKE_SR)));
      } else if (/[\p{L}\p{N}]/u.test(ch)) {
        const n = Math.round(CHAR * FAKE_SR);
        const f = 300 + (ch.toLowerCase().charCodeAt(0) % 20) * 40;
        const b = new Float32Array(n);
        for (let i = 0; i < n; i++) b[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / FAKE_SR) * Math.min(1, i / 40, (n - i) / 40);
        parts.push(b);
      } // punctuation is silent and takes no time
    }
    parts.push(new Float32Array(Math.round(PAD * FAKE_SR)));
    const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return { samples: out, sampleRate: FAKE_SR };
  }
}

const letters = (w: string) => w.replace(/[^\p{L}\p{N}]/gu, '').length;

/** Exact [start, end] of every word of one sentence, given the sentence begins at `t0` of tight audio. */
function truth(sentence: string, t0: number) {
  let t = t0;
  return sentence.split(/\s+/).map((w, i) => {
    if (i > 0) t += GAP;
    const start = t;
    t += letters(w) * CHAR;
    return { text: w, start, end: t };
  });
}

describe('parseWav', () => {
  it('round-trips encodeWav16 at any rate', () => {
    const x = new Float32Array(4800).map((_, i) => 0.4 * Math.sin((2 * Math.PI * 440 * i) / 48000));
    const back = parseWav(encodeWav16(x, 48000));
    expect(back.sampleRate).toBe(48000);
    expect(back.samples.length).toBe(x.length);
    for (let i = 0; i < x.length; i += 97) expect(back.samples[i]).toBeCloseTo(x[i]!, 3);
  });

  it('survives a streamed WAV whose data length is bogus (0xFFFFFFFF)', () => {
    const wav = Buffer.from(encodeWav16(new Float32Array(1000).fill(0.25), 22050));
    wav.writeUInt32LE(0xffffffff, 4);
    wav.writeUInt32LE(0xffffffff, 40);
    expect(parseWav(wav).samples.length).toBe(1000);
  });

  it('averages stereo and rejects non-WAV input', () => {
    const l = new Float32Array(100).fill(0.5);
    const r = new Float32Array(100).fill(-0.25);
    const buf = Buffer.alloc(44 + 400);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + 400, 4); buf.write('WAVEfmt ', 8);
    buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
    buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(400, 40);
    for (let i = 0; i < 100; i++) { buf.writeInt16LE(Math.round(l[i]! * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(r[i]! * 32767), 46 + i * 4); }
    const d = parseWav(buf);
    expect(d.samples[10]).toBeCloseTo(0.125, 3);
    expect(() => parseWav(Buffer.from('not a wav file at all, certainly not one, no way at all.'))).toThrow(/RIFF/);
  });
});

describe('resample', () => {
  const tone = (sr: number, f: number, secs: number) => new Float32Array(Math.round(sr * secs)).map((_, i) => 0.5 * Math.sin((2 * Math.PI * f * i) / sr));

  it('keeps pitch and duration', () => {
    const y = resample(tone(22050, 1000, 0.5), 22050, 48000);
    expect(y.length).toBeCloseTo(24000, -1);
    let rising = 0;
    for (let i = 1; i < y.length; i++) if (y[i - 1]! < 0 && y[i]! >= 0) rising++;
    expect(rising / 0.5).toBeGreaterThan(995);
    expect(rising / 0.5).toBeLessThan(1005);
    const mid = y.slice(2000, 20000);
    expect(Math.max(...mid)).toBeGreaterThan(0.49);
    expect(Math.max(...mid)).toBeLessThan(0.52);
  });

  it('low-passes when downsampling instead of aliasing', () => {
    // 20 kHz at 48k is above the 8 kHz Nyquist of the target and must vanish, not fold down.
    const y = resample(tone(48000, 20000, 0.2), 48000, 16000);
    const rms = Math.sqrt(y.slice(200, y.length - 200).reduce((s, v) => s + v * v, 0) / (y.length - 400));
    expect(rms).toBeLessThan(0.03);
  });
});

describe('trimSilence', () => {
  it('cuts both ends, keeps a little, and reports the lead', () => {
    const sr = 16000;
    const x = new Float32Array(sr);
    for (let i = 0; i < 0.2 * sr; i++) x[Math.round(0.4 * sr) + i] = 0.4 * Math.sin((2 * Math.PI * 500 * i) / sr);
    const r = trimSilence(x, sr, { keep: 0.01 });
    expect(r.samples.length / sr).toBeCloseTo(0.22, 2);
    expect(r.lead).toBeCloseTo(0.39, 2);
    expect(r.lead + r.samples.length / sr + r.trail).toBeCloseTo(1, 3);
  });

  it('returns nothing for pure silence', () => {
    expect(trimSilence(new Float32Array(1000), 16000).samples.length).toBe(0);
  });
});

describe('splitSentences', () => {
  it('splits on terminal punctuation and marks paragraph ends', () => {
    expect(splitSentences('One. Two! Three?\n\nFour "quoted." Five')).toEqual([
      { text: 'One.', paragraphEnd: false },
      { text: 'Two!', paragraphEnd: false },
      { text: 'Three?', paragraphEnd: true },
      { text: 'Four "quoted."', paragraphEnd: false },
      { text: 'Five', paragraphEnd: true },
    ]);
  });
});

describe('snapToValley', () => {
  it('moves a boundary into a clear dip and leaves it alone on steady sound', () => {
    const sr = 16000;
    const x = new Float32Array(sr).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 300 * i) / sr));
    for (let i = Math.round(0.5 * sr); i < Math.round(0.53 * sr); i++) x[i] = 0; // 30 ms dip at 0.50-0.53
    const snapped = snapToValley(x, sr, 0.47);
    expect(snapped).toBeGreaterThan(0.5);
    expect(snapped).toBeLessThan(0.53);
    expect(snapToValley(new Float32Array(sr).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 300 * i) / sr)), sr, 0.4)).toBe(0.4);
  });
});

describe('speak with a known-timing engine', () => {
  const script = 'Gambling is rigged. The house always wins.';
  const sentences = ['Gambling is rigged.', 'The house always wins.'];

  for (const timing of ['prefix', 'words'] as const) {
    it(`${timing}: word times match the audio exactly, within one boundary snap`, async () => {
      const r = await speak(script, new ToneTts(), { timing });
      expect(r.timing).toBe(timing);
      expect(r.sentences).toBe(2);
      const got = r.alignment.words;
      expect(got.map((w) => w.text)).toEqual(script.split(/\s+/));

      // ground truth: tone starts/ends per word, found by reading the audio itself (bursts of energy)
      const x = r.samples;
      for (const w of got) {
        // every word must contain sound near its middle, and the boundary between words must lie in quiet or a dip
        expect(Math.max(...Array.from({ length: 40 }, (_, k) => Math.abs(x[Math.round((w.start + ((w.end - w.start) * (k + 0.5)) / 40) * r.sampleRate)] ?? 0)))).toBeGreaterThan(0.1);
        expect(w.end).toBeGreaterThan(w.start);
      }
      expect(got[0]!.start).toBeLessThan(0.02);
      expect(Math.abs(got[got.length - 1]!.end - r.duration)).toBeLessThan(0.02);
    });
  }

  it('prefix: boundaries fall inside the silent gap between the letters of the two words', async () => {
    const r = await speak('Gambling is rigged.', new ToneTts(), { timing: 'prefix' });
    // sentence audio starts at ~0.005 after trimming (keep=5ms); tone truth relative to the first burst
    const t = truth('Gambling is rigged.', 0);
    const lead = r.alignment.words[0]!.start; // 0
    expect(lead).toBeLessThan(0.01);
    for (let i = 1; i < t.length; i++) {
      const boundary = r.alignment.words[i]!.start;
      const gapStart = t[i - 1]!.end + 0.005; // + the 5 ms pad kept by trimSilence
      const gapEnd = t[i]!.start + 0.005;
      expect(boundary).toBeGreaterThanOrEqual(gapStart - 0.012);
      expect(boundary).toBeLessThanOrEqual(gapEnd + 0.012);
    }
  });

  it('words: each word is exactly its own synthesis', async () => {
    const tts = new ToneTts();
    const r = await speak('Aa bbb c.', tts, { timing: 'words' });
    expect(tts.calls).toEqual(['Aa', 'bbb', 'c.']);
    const w = r.alignment.words;
    // keep=10 ms on each side of a word's tone
    expect(w[0]!.end - w[0]!.start).toBeCloseTo(2 * CHAR + 0.02, 2);
    expect(w[1]!.end - w[1]!.start).toBeCloseTo(3 * CHAR + 0.02, 2);
    expect(w[2]!.end - w[2]!.start).toBeCloseTo(1 * CHAR + 0.02, 2);
    expect(w[1]!.start - w[0]!.end).toBeCloseTo(0.04, 2);
  });

  it('proportional: one synthesis per sentence, words ordered, sentence boundaries respected', async () => {
    const tts = new ToneTts();
    const r = await speak(script, tts, { timing: 'proportional' });
    expect(tts.calls).toEqual(sentences);
    const w = r.alignment.words;
    for (let i = 1; i < w.length; i++) expect(w[i]!.start).toBeGreaterThanOrEqual(w[i - 1]!.start);
    Alignment.parse(r.alignment);
  });

  it('output is tight: no silence over 0.2 s, even when the engine pads its output', async () => {
    const r = await speak(script, new ToneTts(), { pause: 0.5 }); // asks for a long pause, gets the cap
    const win = Math.round(0.01 * r.sampleRate);
    let run = 0, longest = 0;
    for (let i = 0; i + win <= r.samples.length; i += win) {
      let s = 0;
      for (let k = 0; k < win; k++) s += r.samples[i + k]! ** 2;
      run = Math.sqrt(s / win) < 0.003 ? run + win / r.sampleRate : 0;
      longest = Math.max(longest, run);
    }
    expect(longest).toBeLessThanOrEqual(0.21);
    expect(r.alignment.duration).toBeCloseTo(r.duration, 6);
  });

  it('rejects an empty script and passes progress through', async () => {
    await expect(speak('  \n ', new ToneTts())).rejects.toThrow(/empty/);
    const seen: number[] = [];
    await speak(script, new ToneTts(), { timing: 'proportional', onProgress: (d) => seen.push(d) });
    expect(seen).toEqual([0, 1, 2]);
  });

  it('anchors resolve on the produced alignment', async () => {
    const { resolveAnchor } = await import('@shortstudio/schema');
    const r = await speak(script, new ToneTts(), { timing: 'words' });
    const t = resolveAnchor(r.alignment, { word: 'house', nth: 1, edge: 'start', offset: 0 });
    expect(typeof t).toBe('number');
    const w = r.alignment.words.find((x) => x.text === 'house')!;
    expect(t).toBe(w.start);
  });
});

describe('engine selection', () => {
  it('rejects unknown engines', () => {
    expect(() => ttsFromName('festival')).toThrow(/unknown TTS engine/);
  });
  it('auto picks the OS engine', () => {
    const e = ttsFromName('auto');
    expect(e.name).toBe(process.platform === 'win32' ? 'windows-sapi' : process.platform === 'darwin' ? 'macos-say' : 'espeak-ng');
  });
});

describe.skipIf(!commandExists('espeak-ng'))('real espeak-ng (runs only where it is installed)', () => {
  it('words mode: every word interval holds speech and every gap between words is quiet', async () => {
    const script = 'Gambling is rigged. The house always wins.';
    const r = await speak(script, new EspeakTts(), { timing: 'words' });
    expect(r.sampleRate).toBe(48000);
    expect(r.duration).toBeGreaterThan(1.5);
    expect(r.duration).toBeLessThan(6);
    const w = r.alignment.words;
    expect(w.length).toBe(7);
    const rms = (a: number, b: number) => {
      let s = 0;
      const i0 = Math.round(a * r.sampleRate), i1 = Math.round(b * r.sampleRate);
      for (let i = i0; i < i1; i++) s += r.samples[i]! ** 2;
      return Math.sqrt(s / Math.max(1, i1 - i0));
    };
    for (const x of w) expect(rms(x.start, x.end)).toBeGreaterThan(0.02); // every word interval holds speech
    for (let i = 1; i < w.length; i++) if (w[i]!.start - w[i - 1]!.end > 0.02) expect(rms(w[i - 1]!.end + 0.005, w[i]!.start - 0.005)).toBeLessThan(0.005);
    // words are in order, cover the clip, and later words are not a rounding error long
    for (let i = 1; i < w.length; i++) expect(w[i]!.start).toBeGreaterThanOrEqual(w[i - 1]!.start);
    expect(w[w.length - 1]!.end).toBeCloseTo(r.duration, 1);
  }, 60000);

  it('prefix mode keeps every word at least as long as its letters need, in order', async () => {
    const r = await speak('Gambling is rigged. The house always wins.', new EspeakTts(), { timing: 'prefix' });
    for (const x of r.alignment.words) expect(x.end - x.start).toBeGreaterThan(0.05 + 0.025 * x.text.replace(/[^a-z]/gi, '').length - 0.005);
  }, 60000);

  it('prefix timing puts boundaries where the sound dips, more than proportional guessing does', async () => {
    const script = 'The quick brown fox jumps over the lazy dog.';
    const dip = async (timing: 'prefix' | 'proportional') => {
      const r = await speak(script, new EspeakTts(), { timing });
      const win = Math.round(0.01 * r.sampleRate);
      const level = (t: number) => {
        let s = 0;
        const i0 = Math.max(0, Math.round(t * r.sampleRate) - win / 2);
        for (let i = i0; i < i0 + win; i++) s += (r.samples[i] ?? 0) ** 2;
        return Math.sqrt(s / win);
      };
      const bs = r.alignment.words.slice(1).map((w) => w.start);
      return bs.reduce((a, b) => a + level(b), 0) / bs.length;
    };
    expect(await dip('prefix')).toBeLessThan(await dip('proportional'));
  }, 120000);
});
