import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Alignment, projectDuration, type Bundle } from '@shortstudio/schema';
import { SAMPLE_RATE, SfxManifest, autoSfx, decodeAudio, manifestCues, mix, type Cue, type MixReport, type Stems } from '@shortstudio/audio';

export interface ProjectMixOptions {
  /** A music bed file; defaults to audio/music_bed.wav when present. */
  music?: string;
  /** Switch off effects derived from the timeline (a hand-written manifest still applies). */
  noAuto?: boolean;
  /** Switch off all effects. */
  noSfx?: boolean;
  /** Cap on effects per minute (default 20, the spec's upper bound). */
  maxSfxPerMinute?: number;
}

export interface ProjectMix {
  master: Float32Array;
  report: MixReport;
  stems: Stems;
  /** False when there is nothing to put on an audio track. */
  hasAudio: boolean;
  sources: { voice?: string; music?: string; cues: number };
}

/** Voiceover + effects (manifest and timeline) + music for a project, mixed and mastered. */
export function mixProject(projectDir: string, bundle: Bundle, voiceover: string | undefined, opts: ProjectMixOptions = {}): ProjectMix {
  const dir = resolve(projectDir);
  const duration = projectDuration(bundle);
  const voice = voiceover ? decodeAudio(voiceover) : undefined;

  const cues: Cue[] = [];
  const problems: string[] = [];
  if (!opts.noSfx) {
    const manifestPath = join(dir, 'audio/sfx_manifest.json');
    const manifest = existsSync(manifestPath) ? SfxManifest.parse(JSON.parse(readFileSync(manifestPath, 'utf8'))) : undefined;
    if (!opts.noAuto && (manifest?.auto ?? true)) cues.push(...autoSfx(bundle));
    if (manifest) {
      const r = manifestCues(manifest, bundle.alignment as Alignment | undefined);
      cues.push(...r.cues);
      problems.push(...r.problems);
    }
  }
  if (problems.length) throw new Error(`audio/sfx_manifest.json:\n - ${problems.join('\n - ')}`);

  const musicPath = opts.music ?? (existsSync(join(dir, 'audio/music_bed.wav')) ? join(dir, 'audio/music_bed.wav') : undefined);
  const music = musicPath ? decodeAudio(musicPath) : undefined;

  const m = mix({
    sampleRate: SAMPLE_RATE, duration, voice, cues, music, maxHitsPerMinute: opts.maxSfxPerMinute,
    loadFile: (p) => decodeAudio(resolve(dir, p)),
  });
  return { ...m, hasAudio: Boolean(voice) || cues.length > 0 || Boolean(music), sources: { voice: voiceover, music: musicPath, cues: cues.length } };
}

export function describeMix(m: ProjectMix): string[] {
  const r = m.report;
  const lines = [
    `voiceover   ${r.voiceAnchored ? `${r.voiceLufs.toFixed(1)} LUFS (0 LU anchor)` : 'none'}`,
    `effects     ${r.cues.length} cues, ${r.hitsPerMinute.toFixed(1)}/min (hits -10 LU, whooshes -15 LU)${r.dropped.length ? `, ${r.dropped.length} dropped` : ''}`,
    `music       ${r.musicGainDb !== undefined ? `${(r.voiceLufs - 18).toFixed(1)} LUFS (-18 LU, no ducking)` : 'none'}`,
    `master      ${Number.isFinite(r.masterLufs) ? `${r.masterLufs.toFixed(1)} LUFS, true peak ${r.truePeakDb.toFixed(1)} dBTP` : 'silent'}`,
  ];
  for (const n of r.notes) lines.push(`note: ${n}`);
  return lines;
}
