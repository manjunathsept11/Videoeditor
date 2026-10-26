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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { runQualityGate } from '@shortstudio/qa';
import { loadProject } from './project';
import { printGate } from './qa';

const here = dirname(fileURLToPath(import.meta.url));

function args() {
  const pos: string[] = [];
  const opt: Record<string, string> = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startsWith('--')) opt[a[i]!.slice(2)] = a[++i] ?? '';
    else pos.push(a[i]!);
  }
  return { pos, opt };
}

async function main() {
  const { pos, opt } = args();
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

  const server = await createServer({
    root: join(here, 'web'),
    server: { port: 0, host: '127.0.0.1' },
    logLevel: 'error',
    configFile: false,
  });
  await server.listen();
  const url = server.resolvedUrls!.local[0]!;

  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('pageerror', (e) => console.error('[page error]', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
    await page.goto(url);
    await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true);
    const duration = await page.evaluate(([w, h, b]) => window.studioApi.init(w as number, h as number, b as never), [width, height, bundle] as const);
    await page.evaluate(() => document.fonts.ready);

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
    await browser.close();
    await server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
