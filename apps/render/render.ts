/**
 * Headless deterministic renderer: project dir -> MP4 (or a single PNG frame).
 *
 *   npm run render -- examples/demo out/demo.mp4 [--scale 0.5] [--fps 30]
 *   npm run render -- examples/demo out/f.png --frame 20 [--scale 0.5]
 *
 * The quality gate runs first; errors stop the render unless --force is given.
 *
 * If the project has audio/voiceover_tight.wav (or --audio is given) it is muxed in.
 * Word anchors resolve against audio/alignment.json.
 *
 * Frames are stepped by index, never by wall clock: frame N always renders t = N / fps.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runQualityGate } from '@shortstudio/qa';
import { loadProject } from './project';
import { printGate } from './qa';
import { openStudio, parseArgs } from './session';

async function main() {
  const { pos, opt } = parseArgs(process.argv.slice(2));
  const [projectDir, outPath] = pos;
  if (!projectDir || !outPath) throw new Error('usage: render <projectDir> <out.mp4|out.png> [--scale s] [--fps 30|60] [--frame n]');

  const { bundle, voiceover } = loadProject(projectDir);
  const gate = runQualityGate(bundle);
  if (gate.issues.length) {
    console.log('quality gate:');
    printGate(gate);
  }
  if (!gate.passed && !('force' in opt)) {
    throw new Error(`quality gate failed; run \`npm run qa -- ${projectDir} --fix\` or pass --force to render anyway`);
  }
  const scale = Number(opt.scale ?? 1);
  const fps = Number(opt.fps ?? bundle.project.fps);
  const width = Math.round((bundle.project.width * scale) / 2) * 2;
  const height = Math.round((bundle.project.height * scale) / 2) * 2;

  const { page, duration, close } = await openStudio(bundle, width, height);
  try {
    const total = Math.round(duration * fps);
    mkdirSync(resolve(dirname(outPath)), { recursive: true });

    if (opt.frame !== undefined) {
      const f = Number(opt.frame);
      const b64 = await page.evaluate(([t]) => window.studioApi.renderAt(t as number, 'image/png'), [f / fps] as const);
      writeFileSync(outPath, Buffer.from(b64, 'base64'));
      console.log(`frame ${f} (t=${(f / fps).toFixed(3)}s) -> ${outPath}`);
      return;
    }

    const audio = opt.audio ?? voiceover;
    const ff = spawn('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
      ...(audio ? ['-i', audio] : []),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-preset', 'medium', '-movflags', '+faststart',
      ...(audio ? ['-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
      outPath,
    ], { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise<void>((res, rej) => {
      ff.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`))));
      ff.on('error', rej);
    });

    const t0 = Date.now();
    for (let f = 0; f < total; f++) {
      const b64 = await page.evaluate(([t]) => window.studioApi.renderAt(t as number, 'image/png'), [f / fps] as const);
      if (!ff.stdin.write(Buffer.from(b64, 'base64'))) await new Promise((r) => ff.stdin.once('drain', r));
      if (f % 15 === 0) process.stdout.write(`\rframe ${f + 1}/${total}`);
    }
    ff.stdin.end();
    await done;
    console.log(`\n${total} frames @ ${fps}fps ${width}x${height} -> ${outPath} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } finally {
    await close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
