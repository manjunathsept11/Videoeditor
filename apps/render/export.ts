/**
 * Final export: WebCodecs video (no screen capture) + FFmpeg-free audio mix, muxed to one MP4.
 *
 *   npm run export -- <projectDir> <out.mp4> [--scale 1] [--fps 60] [--music file.wav] [--no-sfx] [--no-auto] [--max-sfx n] [--force]
 *
 * Video: the engine renders frame N at t = N / fps and hands it to a WebCodecs VideoEncoder (H.264 when the browser has
 * it, VP9/AV1 otherwise) muxed with mp4-muxer. Audio: voiceover is the 0 LU anchor, hits -10 LU, whooshes -15 LU, music
 * -18 LU with no ducking, master -14 LUFS at -1 dBTP. ffmpeg only attaches the audio (copying H.264 as-is).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runQualityGate } from '@shortstudio/qa';
import { finishExport } from './finishExport';
import { loadProject } from './project';
import { printGate } from './qa';
import { openStudio, parseArgs } from './session';

async function main() {
  const { pos, opt } = parseArgs(process.argv.slice(2));
  const [projectDir, outPath] = pos;
  if (!projectDir || !outPath) throw new Error('usage: export <projectDir> <out.mp4> [--scale s] [--fps 30|60] [--music file] [--no-sfx] [--no-auto] [--max-sfx n] [--force]');

  const { bundle, voiceover } = loadProject(projectDir);
  const gate = runQualityGate(bundle);
  if (gate.issues.length) {
    console.log('quality gate:');
    printGate(gate);
  }
  if (!gate.passed && !('force' in opt)) throw new Error(`quality gate failed; run \`npm run qa -- ${projectDir} --fix\` or pass --force`);

  const scale = Number(opt.scale ?? 1);
  const fps = Number(opt.fps ?? bundle.project.fps);
  const width = Math.round((bundle.project.width * scale) / 2) * 2;
  const height = Math.round((bundle.project.height * scale) / 2) * 2;
  const work = mkdtempSync(join(tmpdir(), 'shortstudio-'));
  const videoPath = join(work, 'video.mp4');
  mkdirSync(resolve(dirname(outPath)), { recursive: true });

  try {
    // ---- video
    const t0 = Date.now();
    const { page, close } = await openStudio(bundle, width, height);
    let summary: { codec: string; mux: string; frames: number; bytes: number };
    try {
      const ticker = setInterval(async () => {
        try {
          const p = await page.evaluate(() => window.studioApi.progress());
          if (p.total) process.stdout.write(`\rencoding ${p.done}/${p.total}`);
        } catch { /* page busy or closed */ }
      }, 1000);
      summary = await page.evaluate((o) => window.studioApi.exportVideo(o), { fps, codec: opt.codec } as { fps: number; codec?: string });
      clearInterval(ticker);
      const chunks: Buffer[] = [];
      const CHUNK = 3 * 1024 * 1024;
      for (let off = 0; off < summary.bytes; off += CHUNK) {
        chunks.push(Buffer.from(await page.evaluate(([o, l]) => window.studioApi.readChunk(o as number, l as number), [off, CHUNK] as const), 'base64'));
      }
      writeFileSync(videoPath, Buffer.concat(chunks));
    } finally {
      await close();
    }
    console.log(`\nvideo   ${summary.frames} frames @ ${fps}fps ${width}x${height}, ${summary.codec} (${(summary.bytes / 1e6).toFixed(1)} MB) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

    // ---- audio + attach
    const done = finishExport({
      projectDir, bundle, voiceover, videoPath, mux: summary.mux, outPath,
      mixOptions: { music: opt.music, noAuto: 'no-auto' in opt, noSfx: 'no-sfx' in opt, maxSfxPerMinute: opt['max-sfx'] ? Number(opt['max-sfx']) : undefined },
    });
    for (const l of done.lines) console.log(l);
    console.log(`wrote ${outPath} (${done.mix.hasAudio ? 'with audio' : 'no audio'}) and ${done.reportPath}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
