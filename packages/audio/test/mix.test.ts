import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Alignment, parseBundle } from '@shortstudio/schema';
import { MASTER_LUFS, mix } from '../src/mix';
import { dbToGain, gainToDb, integratedLufs, samplePeak, truePeak, ungatedLufs } from '../src/loudness';
import { DENSITY, autoSfx, hitsPerMinute, limitDensity, manifestCues, SfxManifest, type Cue } from '../src/sfx';
import { synthesize, type SynthKind } from '../src/synth';
import { encodeWavStereo16 } from '../src/wav';

const SR = 48000;
const KINDS: SynthKind[] = ['impact', 'whoosh', 'tick', 'ding', 'pageflip', 'steps'];
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function speechLike(secs: number, amp = 0.35): Float32Array {
  let s = 7;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  return Float32Array.from({ length: Math.round(secs * SR) }, (_, i) => {
    const t = i / SR;
    const syll = Math.max(0, Math.sin(2 * Math.PI * 3.7 * t)) ** 2;
    const phrase = t % 2.4 < 1.9 ? 1 : 0.02;
    const tone = Math.sin(2 * Math.PI * 140 * t) * 0.5 + Math.sin(2 * Math.PI * 700 * t) * 0.3 + Math.sin(2 * Math.PI * 1800 * t) * 0.15;
    return (tone + rnd() * 0.12) * syll * phrase * amp;
  });
}
const music = (secs: number) => Float32Array.from({ length: Math.round(secs * SR) }, (_, i) => 0.2 * Math.sin((2 * Math.PI * 220 * i) / SR) + 0.1 * Math.sin((2 * Math.PI * 330 * i) / SR));
const cue = (at: number, kind: Cue['kind'], extra: Partial<Cue> = {}): Cue => ({ at, kind, gainDb: 0, priority: 3, source: 'auto', why: kind, ...extra });

describe('synthesized effects', () => {
  it('are normalised, non-silent, and exactly repeatable', () => {
    for (const k of KINDS) {
      const a = synthesize(k, SR), b = synthesize(k, SR);
      expect(samplePeak(a), k).toBeCloseTo(1, 6);
      expect(a.length, k).toBeGreaterThan(SR * 0.05);
      expect(a.length, k).toBeLessThan(SR * 1.2);
      expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer)), `${k} repeats`).toBe(true);
    }
  });
  it('sound different from each other, and footsteps vary', () => {
    const e = KINDS.map((k) => ungatedLufs([synthesize(k, SR)], SR));
    expect(new Set(e.map((v) => v.toFixed(2))).size).toBe(KINDS.length);
    expect(Buffer.from(synthesize('steps', SR, 0).buffer).equals(Buffer.from(synthesize('steps', SR, 1).buffer))).toBe(false);
  });
});

describe('autoSfx from the timeline', () => {
  const cam = { position: [0, 1.8, 10], target: [0, 1.6, 0], fov: 40 };
  const bundle = parseBundle({
    project: { name: 't', sets: ['s'], shots: ['a', 'b'] },
    sets: [{ id: 's', background: '#000000', objects: [] }],
    shots: [
      { id: 'a', set: 's', start: 0, duration: 4, camera: cam, actors: [{ id: 'ken', bodyColor: '#ff8800', position: [0, 0, 0] }],
        props: [{ kind: 'counter', id: 'yen', position: [0, 4, 0] }, { kind: 'dial', id: 'd', position: [2, 4, 0] }, { kind: 'calendar', id: 'c', position: [-2, 4, 0] }],
        propEvents: [{ prop: 'yen', at: 1, value: 10 }, { prop: 'd', at: 1.5, value: 50 }, { prop: 'c', at: 2, value: 5 }],
        events: [{ type: 'jolt', actor: 'ken', at: 2.5 }, { type: 'walk', actor: 'ken', at: 0.2, until: 0.9, to: [0.5, 0] }] },
      { id: 'b', set: 's', start: 4, duration: 3, camera: cam, transitionIn: { type: 'dissolve' } },
    ],
  });
  const cues = autoSfx(bundle);
  const find = (kind: string, at?: number) => cues.find((c) => c.kind === kind && (at === undefined || Math.abs(c.at - at) < 1e-9));

  it('puts a whoosh just before each shot change', () => {
    expect(find('whoosh')!.at).toBeCloseTo(4 - 0.08, 9);
  });
  it('lands a tick / ding / page-flip on the exact frame each prop reaches its value', () => {
    expect(find('tick', 1)).toBeTruthy();
    expect(find('ding', 1.5)).toBeTruthy();
    expect(find('pageflip', 2)).toBeTruthy();
  });
  it('hits the jolt and gives a walk one cue with a footfall per step', () => {
    expect(find('impact', 2.5)!.priority).toBe(5);
    const steps = find('steps', 0.2)!;
    expect(steps.offsets!.length).toBeGreaterThanOrEqual(2);
    expect(steps.offsets![0]).toBeGreaterThan(0.15); // one step time (5-6 frames) after the walk starts
    expect(steps.offsets![0]).toBeLessThan(0.22);
    expect(steps.offsets!.at(-1)).toBeCloseTo(0.7, 6); // the last foot lands exactly when the walk ends
  });
  it('comes back in time order', () => {
    expect(cues.map((c) => c.at)).toEqual([...cues.map((c) => c.at)].sort((a, b) => a - b));
  });
});

describe('density cap', () => {
  const many = Array.from({ length: 60 }, (_, i) => cue(i, 'whoosh', { priority: i % 3 }));
  it('keeps at most 20 per minute and prefers high priority', () => {
    const { kept, dropped } = limitDensity(many, 60);
    expect(kept).toHaveLength(DENSITY.max);
    expect(kept.length + dropped.length).toBe(60);
    expect(Math.min(...kept.map((c) => c.priority))).toBe(2);
    expect(kept.map((c) => c.at)).toEqual([...kept.map((c) => c.at)].sort((a, b) => a - b));
  });
  it('never drops a hand-written cue before an auto cue', () => {
    const mixed = [...many, cue(30.5, 'impact', { priority: 10, source: 'manifest' })];
    expect(limitDensity(mixed, 60).kept.some((c) => c.source === 'manifest')).toBe(true);
  });
  it('scales with length and measures density', () => {
    expect(limitDensity(many, 30).kept).toHaveLength(10);
    expect(hitsPerMinute(many.slice(0, 15), 60)).toBe(15);
  });
});

describe('hand-written manifest', () => {
  const al = Alignment.parse({ words: [{ text: 'boom', start: 1.25, end: 1.6 }, { text: 'again', start: 3, end: 3.4 }] });
  it('resolves word anchors and plain seconds', () => {
    const m = SfxManifest.parse({ cues: [{ at: { word: 'boom' }, kind: 'impact', gain: 2 }, { at: 5, kind: 'whoosh' }] });
    const r = manifestCues(m, al);
    expect(r.problems).toEqual([]);
    expect(r.cues.map((c) => [c.at, c.kind, c.gainDb])).toEqual([[1.25, 'impact', 2], [5, 'whoosh', 0]]);
  });
  it('reports a missing word and a missing alignment', () => {
    expect(manifestCues(SfxManifest.parse({ cues: [{ at: { word: 'nope' }, kind: 'tick' }] }), al).problems[0]).toMatch(/not found/);
    expect(manifestCues(SfxManifest.parse({ cues: [{ at: { word: 'boom' }, kind: 'tick' }] })).problems[0]).toMatch(/no alignment/);
  });
});

describe('mix: levels relative to the voiceover, then a -14 LUFS master', () => {
  const voice = speechLike(20);
  const cues = [cue(2, 'impact'), cue(6, 'whoosh'), cue(9, 'tick'), cue(12, 'ding'), cue(15, 'pageflip'), cue(17, 'steps', { offsets: [0.2, 0.4, 0.6] })];
  const r = mix({ duration: 20, voice, cues, music: music(8) });

  it('anchors on the measured voiceover loudness', () => {
    expect(r.report.voiceAnchored).toBe(true);
    expect(r.report.voiceLufs).toBeCloseTo(integratedLufs([voice, voice], SR), 9);
  });

  it('puts each effect at its class level: hits -10 LU, whooshes -15 LU (re-measured from the rendered stem)', () => {
    const solo = (c: Cue) => mix({ duration: 6, voice: speechLike(6), cues: [{ ...c, at: 1 }] });
    for (const [kind, offset] of [['impact', -10], ['tick', -10], ['ding', -10], ['whoosh', -15], ['pageflip', -15]] as const) {
      const m = solo(cue(1, kind));
      const len = synthesize(kind, SR).length; // measured over the effect's own duration, as the mixer measures it
      const stem = m.stems.fx.subarray(SR, SR + len);
      expect(ungatedLufs([stem, stem], SR) - m.report.voiceLufs, kind).toBeCloseTo(offset, 0);
    }
  });

  it('puts the music at -18 LU under the voice, and does not duck it', () => {
    const m = r.stems.music;
    const bed = music(8);
    const l = integratedLufs([m, m], SR);
    expect(l - r.report.voiceLufs).toBeCloseTo(-18, 0);
    // the same constant gain applies during speech and during the pauses between phrases
    const g = r.report.musicGainDb!;
    const at = (t: number) => m[Math.round(t * SR)]! / (bed[Math.round(t * SR) % bed.length]! || 1);
    const speaking = 1.0, pause = 2.2; // phrases run 0-1.9s of each 2.4s
    expect(Math.abs(Math.abs(at(speaking)) - dbToGain(g))).toBeLessThan(dbToGain(g) * 0.05 + 1e-6);
    expect(Math.abs(Math.abs(at(pause)) - dbToGain(g))).toBeLessThan(dbToGain(g) * 0.05 + 1e-6);
  });

  it('lands the master on -14 LUFS with true peak at or under -1 dBTP', () => {
    expect(MASTER_LUFS).toBe(-14);
    expect(Math.abs(r.report.masterLufs + 14)).toBeLessThan(0.1);
    expect(r.report.truePeakDb).toBeLessThanOrEqual(-1 + 0.05);
    expect(Math.abs(integratedLufs([r.master, r.master], SR) - r.report.masterLufs)).toBeLessThan(1e-9);
  });

  it('reports what it did for every cue', () => {
    expect(r.report.cues).toHaveLength(6);
    const impact = r.report.cues.find((c) => c.kind === 'impact')!;
    expect(impact.class).toBe('hit');
    expect(impact.targetLufs).toBeCloseTo(r.report.voiceLufs - 10, 9);
    expect(r.report.cues.find((c) => c.kind === 'whoosh')!.targetLufs).toBeCloseTo(r.report.voiceLufs - 15, 9);
  });

  it('a quieter voiceover just moves everything with it (levels are relative, the master is fixed)', () => {
    const quiet = mix({ duration: 20, voice: voice.map((v) => v * 0.25), cues, music: music(8) });
    expect(quiet.report.voiceLufs).toBeCloseTo(r.report.voiceLufs - 12.04, 1);
    expect(quiet.report.masterLufs).toBeCloseTo(-14, 1);
    expect(quiet.report.cues[0]!.targetLufs).toBeCloseTo(quiet.report.voiceLufs - 10, 9);
  });

  it.skipIf(!hasFfmpeg)('ffmpeg ebur128, an independent meter, confirms -14 LUFS and the true-peak ceiling', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mix-')), 'master.wav');
    writeFileSync(path, encodeWavStereo16(r.master, r.master));
    const out = spawnSync('ffmpeg', ['-nostats', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const sum = out.slice(out.lastIndexOf('Summary:'));
    const I = Number(/I:\s+(-?[\d.]+)\s+LUFS/.exec(sum)![1]);
    const peak = Number(/Peak:\s+(-?[\d.]+)\s+dBFS/.exec(sum)![1]);
    expect(Math.abs(I + 14), `ffmpeg says ${I} LUFS`).toBeLessThan(0.15);
    expect(peak, `ffmpeg says ${peak} dBTP`).toBeLessThanOrEqual(-1.0);
  });
});

describe('mix: edge cases', () => {
  it('with no voiceover it levels against a reference and says so', () => {
    const r = mix({ duration: 5, cues: [cue(1, 'impact')] });
    expect(r.report.voiceAnchored).toBe(false);
    expect(r.report.notes.join(' ')).toMatch(/no voiceover/);
    expect(Math.abs(r.report.masterLufs + 14)).toBeLessThan(0.5);
  });
  it('an empty mix is silent and says so rather than inventing a gain', () => {
    const r = mix({ duration: 2, cues: [] });
    expect(r.report.masterLufs).toBe(-Infinity);
    expect(r.report.notes.join(' ')).toMatch(/silent/);
    expect(samplePeak(r.master)).toBe(0);
  });
  it('uses a cue\'s own file when it names one, and asks for a loader otherwise', () => {
    const own = Float32Array.from({ length: SR / 4 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / SR));
    const r = mix({ duration: 3, voice: speechLike(3), cues: [cue(1, 'impact', { file: 'boom.wav' })], loadFile: () => own });
    expect(r.report.cues).toHaveLength(1);
    expect(() => mix({ duration: 3, voice: speechLike(3), cues: [cue(1, 'impact', { file: 'boom.wav' })] })).toThrow(/no loader/);
  });
  it('warns when a long video has too few effects, and when the voiceover outruns the video', () => {
    const sparse = mix({ duration: 60, voice: speechLike(60), cues: [cue(5, 'impact')] });
    expect(sparse.report.notes.join(' ')).toMatch(/SFX\/minute/);
    const long = mix({ duration: 3, voice: speechLike(5), cues: [] });
    expect(long.report.notes.join(' ')).toMatch(/longer than the video/);
  });
  it('drops the lowest-priority effects when over the cap, and says which', () => {
    const crowded = Array.from({ length: 30 }, (_, i) => cue(i * 0.5 + 0.2, 'tick', { priority: i < 25 ? 1 : 5, why: `c${i}` }));
    const r = mix({ duration: 20, voice: speechLike(20), cues: crowded });
    expect(r.report.cues.length).toBe(Math.floor((DENSITY.max * 20) / 60));
    expect(r.report.dropped.length).toBe(30 - r.report.cues.length);
    expect(r.report.notes.some((n) => n.startsWith('dropped tick'))).toBe(true);
    expect(r.report.cues.filter((c) => c.why >= 'c25').length).toBeGreaterThan(0); // the priority-5 ones survived
  });
  it('gain helpers round-trip', () => {
    expect(gainToDb(dbToGain(-7.3))).toBeCloseTo(-7.3, 9);
    expect(truePeak(new Float32Array(10))).toBe(0);
  });
});
