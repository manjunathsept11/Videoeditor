import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWavStereo16 } from '@shortstudio/audio';
import type { Bundle } from '@shortstudio/schema';
import { describeMix, mixProject, type ProjectMix, type ProjectMixOptions } from './mixproject';

export interface FinishExportOptions {
  projectDir: string;
  bundle: Bundle;
  voiceover?: string;
  /** The video-only MP4 the engine encoded with WebCodecs. */
  videoPath: string;
  /** How that video was encoded: 'avc' is attached as-is, anything else is re-encoded to H.264. */
  mux: string;
  outPath: string;
  mixOptions?: ProjectMixOptions;
  /** Path to ffmpeg; defaults to $FFMPEG_PATH or `ffmpeg`. The desktop app bundles its own. */
  ffmpeg?: string;
}

export interface FinishedExport {
  mix: ProjectMix;
  lines: string[];
  reportPath: string;
}

/**
 * Second half of an export: mix the audio (voiceover anchor, effects, music, -14 LUFS master) and attach it to the
 * encoded video, copying H.264 untouched. Shared by `npm run export` and the desktop app.
 */
export function finishExport(o: FinishExportOptions): FinishedExport {
  const mix = mixProject(o.projectDir, o.bundle, o.voiceover, o.mixOptions);
  const reportPath = o.outPath.replace(/\.mp4$/i, '') + '.mix.json';
  writeFileSync(reportPath, JSON.stringify(mix.report, (_, v) => (v === -Infinity ? null : v), 2));

  const work = mkdtempSync(join(tmpdir(), 'shortstudio-mux-'));
  try {
    const args = ['-y', '-loglevel', 'error', '-i', o.videoPath];
    if (mix.hasAudio) {
      const wav = join(work, 'master.wav');
      writeFileSync(wav, encodeWavStereo16(mix.master, mix.master));
      args.push('-i', wav);
    }
    const copy = o.mux === 'avc';
    args.push('-c:v', copy ? 'copy' : 'libx264', ...(copy ? [] : ['-pix_fmt', 'yuv420p', '-crf', '16']));
    if (mix.hasAudio) args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
    args.push('-movflags', '+faststart', o.outPath);
    const r = spawnSync(o.ffmpeg ?? process.env.FFMPEG_PATH ?? 'ffmpeg', args, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr || r.error}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return { mix, lines: describeMix(mix), reportPath };
}
