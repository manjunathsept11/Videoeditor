/**
 * End to end: the real `npm run export` (WebCodecs in headless Chromium + the mixer + ffmpeg mux), judged by
 * ffprobe and ffmpeg's ebur128, which are independent of our code. Slow (launches a browser), so it lives behind
 * `npm run test:e2e` rather than the default unit run.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../..');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe.skipIf(!hasFfmpeg)('export end to end', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'e2e-')), 'rig.mp4');
  let run: { status: number | null; stdout: string; stderr: string };
  // async, not spawnSync: blocking the worker for a minute makes vitest's runner miss its heartbeat and report an unhandled error
  beforeAll(async () => {
    run = await new Promise((resolveRun) => {
      const child = spawn('npx', ['tsx', 'apps/render/export.ts', 'examples/rig', out, '--scale', '0.2', '--fps', '30', '--max-sfx', '60'], { cwd: root });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      const timer = setTimeout(() => child.kill('SIGKILL'), 170_000);
      child.on('close', (status) => { clearTimeout(timer); resolveRun({ status, stdout, stderr }); });
    });
  }, 180_000);

  it('exports without error', () => {
    expect(run.status, String(run.stderr) + String(run.stdout)).toBe(0);
  });

  it('is H.264 video at the requested size, frame rate and exact length, with an AAC track', () => {
    const p = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames', '-of', 'json', out], { encoding: 'utf8' });
    const { streams } = JSON.parse(p.stdout) as { streams: Record<string, string>[] };
    const v = streams.find((s) => s.codec_type === 'video')!;
    const a = streams.find((s) => s.codec_type === 'audio')!;
    expect(v.codec_name).toBe('h264');
    expect(v.r_frame_rate).toBe('30/1');
    expect(Number(v.nb_frames)).toBe(180); // 6s project at 30fps
    expect(Number(v.width)).toBe(216);
    expect(Number(v.height)).toBe(384);
    expect(a.codec_name).toBe('aac');
  });

  it('master loudness is -14 LUFS with true peak under -1 dBTP, as measured by ffmpeg on the delivered file', () => {
    const r = spawnSync('ffmpeg', ['-nostats', '-i', out, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const sum = r.slice(r.lastIndexOf('Summary:'));
    expect(Math.abs(Number(/I:\s+(-?[\d.]+)\s+LUFS/.exec(sum)![1]) + 14)).toBeLessThan(0.3); // AAC re-encode adds a little
    expect(Number(/Peak:\s+(-?[\d.]+)\s+dBFS/.exec(sum)![1])).toBeLessThanOrEqual(-0.8);
  });

  it('writes a mix report listing each effect', () => {
    const report = JSON.parse(readFileSync(out.replace(/\.mp4$/, '.mix.json'), 'utf8'));
    expect(report.cues.map((c: { kind: string }) => c.kind)).toEqual(expect.arrayContaining(['steps', 'impact']));
    expect(report.masterLufs).toBeCloseTo(-14, 0);
  });
}, 200_000);
