import { SAMPLE_RATE } from './wav';
import { dbToGain, gainToDb, integratedLufs, limit, truePeak, ungatedLufs } from './loudness';
import { DENSITY, KIND_CLASS, LU, hitsPerMinute, limitDensity, type Cue } from './sfx';
import { synthesize } from './synth';

export const MASTER_LUFS = -14; // YouTube Shorts / TikTok
export const TRUE_PEAK_DB = -1;
/** Aim this far under the ceiling: a different meter's oversampling can read a hair higher than ours. */
const TP_MARGIN_DB = 0.1;

export interface MixInput {
  sampleRate?: number;
  /** Length of the video, seconds. */
  duration: number;
  /** Voiceover samples (mono). Without one, levels are set relative to a -23 LUFS reference. */
  voice?: Float32Array;
  cues: Cue[];
  /** Music bed (mono); looped and trimmed to the video, never ducked. */
  music?: Float32Array;
  /** Loads a cue's own audio file; synthesized sound is used when a cue has none. */
  loadFile?: (path: string) => Float32Array;
  targetLufs?: number;
  maxHitsPerMinute?: number;
}

/** The stems as summed, before master gain and limiting (for inspection and tests). */
export interface Stems {
  voice: Float32Array;
  fx: Float32Array;
  music: Float32Array;
}

export interface MixReport {
  voiceLufs: number;
  voiceAnchored: boolean;
  cues: { at: number; kind: string; source: string; class: string; targetLufs: number; gainDb: number; why: string }[];
  dropped: { at: number; kind: string; why: string }[];
  hitsPerMinute: number;
  musicGainDb?: number;
  masterLufs: number;
  truePeakDb: number;
  masterGainDb: number;
  notes: string[];
}

const REFERENCE_LUFS = -23;

function fit(x: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n);
  out.set(x.length > n ? x.subarray(0, n) : x);
  return out;
}

function loop(x: Float32Array, n: number, sr: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = x[i % x.length]!;
  const fadeIn = Math.round(0.3 * sr), fadeOut = Math.round(1.2 * sr);
  for (let i = 0; i < Math.min(fadeIn, n); i++) out[i]! *= i / fadeIn;
  for (let i = 0; i < Math.min(fadeOut, n); i++) out[n - 1 - i]! *= i / fadeOut;
  return out;
}

const addAt = (dst: Float32Array, src: Float32Array, at: number, gain: number) => {
  for (let i = 0; i < src.length; i++) {
    const j = at + i;
    if (j >= 0 && j < dst.length) dst[j]! += src[i]! * gain;
  }
};

/**
 * Mix voiceover, effects and music into one stereo-ready mono master.
 *
 * Levels are relative to the voiceover, which is the 0 LU anchor: each effect is scaled so ITS loudness sits
 * at (voice loudness + class offset), hits -10, whooshes -15, music -18, with no ducking under speech. The sum
 * is then normalised to the master target (-14 LUFS, measured as stereo) and peak-limited to -1 dBTP.
 */
export function mix(input: MixInput): { master: Float32Array; report: MixReport; stems: Stems } {
  const sr = input.sampleRate ?? SAMPLE_RATE;
  const N = Math.max(1, Math.ceil(input.duration * sr));
  const notes: string[] = [];
  const target = input.targetLufs ?? MASTER_LUFS;

  // ---- anchor
  const voice = input.voice ? fit(input.voice, N) : new Float32Array(N);
  if (input.voice && input.voice.length > N) notes.push(`voiceover is ${((input.voice.length - N) / sr).toFixed(1)}s longer than the video and was cut`);
  const measured = input.voice ? integratedLufs([voice, voice], sr) : -Infinity;
  const anchored = Number.isFinite(measured);
  const voiceLufs = anchored ? measured : REFERENCE_LUFS;
  if (!anchored) notes.push(`no voiceover: effects and music are levelled against a ${REFERENCE_LUFS} LUFS reference`);

  // ---- effects
  const { kept, dropped } = limitDensity(input.cues, input.duration, input.maxHitsPerMinute ?? DENSITY.max);
  for (const d of dropped) notes.push(`dropped ${d.kind} at ${d.at.toFixed(2)}s (${d.why}) to stay within ${input.maxHitsPerMinute ?? DENSITY.max} SFX/minute`);
  const fx = new Float32Array(N);
  const cueReports: MixReport['cues'] = [];
  for (const c of kept) {
    const cls = KIND_CLASS[c.kind];
    const targetLufs = voiceLufs + LU[cls];
    const place = (sample: Float32Array, at: number) => {
      const l = ungatedLufs([sample, sample], sr);
      const gainDb = Math.min(30, targetLufs - l + c.gainDb);
      addAt(fx, sample, Math.round(at * sr), dbToGain(gainDb));
      return gainDb;
    };
    let gainDb: number;
    if (c.file) {
      if (!input.loadFile) throw new Error(`cue "${c.why}" names a file but no loader was given`);
      gainDb = place(input.loadFile(c.file), c.at);
    } else if (c.kind === 'steps') {
      gainDb = 0;
      (c.offsets ?? [0]).forEach((o, k) => (gainDb = place(synthesize('steps', sr, k), c.at + o)));
    } else {
      gainDb = place(synthesize(c.kind, sr), c.at);
    }
    cueReports.push({ at: c.at, kind: c.kind, source: c.source, class: cls, targetLufs, gainDb, why: c.why });
  }
  const dens = hitsPerMinute(kept, input.duration);
  if (input.duration >= 20 && dens < DENSITY.min) notes.push(`only ${dens.toFixed(1)} SFX/minute; the spec asks for ${DENSITY.min}-${DENSITY.max}. Add cues in audio/sfx_manifest.json`);

  // ---- music
  let music = new Float32Array(N);
  let musicGainDb: number | undefined;
  if (input.music && input.music.length) {
    const bed = loop(input.music, N, sr);
    const l = integratedLufs([bed, bed], sr);
    if (Number.isFinite(l)) {
      musicGainDb = voiceLufs + LU.music - l;
      music = bed.map((v) => v * dbToGain(musicGainDb!));
    }
  }

  // ---- sum, normalise to the master target, peak-limit to the true-peak ceiling
  const sum = new Float32Array(N);
  for (let i = 0; i < N; i++) sum[i] = voice[i]! + fx[i]! + music[i]!;
  const startL = integratedLufs([sum, sum], sr);
  if (!Number.isFinite(startL)) {
    notes.push('the mix is silent');
    return { master: sum, stems: { voice, fx, music }, report: { voiceLufs, voiceAnchored: anchored, cues: cueReports, dropped: dropped.map((d) => ({ at: d.at, kind: d.kind, why: d.why })), hitsPerMinute: dens, musicGainDb, masterLufs: -Infinity, truePeakDb: -Infinity, masterGainDb: 0, notes } };
  }
  let gainDb = target - startL;
  let master: Float32Array = sum;
  const tpLimit = dbToGain(TRUE_PEAK_DB - TP_MARGIN_DB);
  let ceiling = tpLimit;
  for (let pass = 0; pass < 6; pass++) {
    const g = dbToGain(gainDb);
    master = limit(sum.map((v) => v * g), ceiling, sr);
    const l = integratedLufs([master, master], sr);
    const tp = truePeak(master);
    if (tp > tpLimit * 1.0005) ceiling *= (tpLimit / tp) * 0.999; // inter-sample overshoot: tighten
    else if (Math.abs(l - target) < 0.05) break;
    else gainDb += target - l; // the limiter took some loudness: push the input up
  }
  const finalL = integratedLufs([master, master], sr);
  if (Math.abs(finalL - target) > 0.3) notes.push(`master is ${finalL.toFixed(1)} LUFS: the true-peak limit stopped it reaching ${target}`);
  return {
    master,
    stems: { voice, fx, music },
    report: {
      voiceLufs, voiceAnchored: anchored, cues: cueReports,
      dropped: dropped.map((d) => ({ at: d.at, kind: d.kind, why: d.why })),
      hitsPerMinute: dens, musicGainDb, masterLufs: finalL, truePeakDb: gainToDb(truePeak(master)), masterGainDb: gainDb, notes,
    },
  };
}
