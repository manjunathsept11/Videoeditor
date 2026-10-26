/**
 * The desktop UI, driven for real: Chromium loads the renderer (served with the same ProjectService the Electron app uses),
 * a person clicks things in the rendered picture, and we check what happens on screen AND on disk.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CompletionRequest, LlmProvider } from '@shortstudio/agents';
import { cameraAt, project } from '@shortstudio/qa';
import { loadProject } from '../../render/project';
import { ProjectService } from '../src/service';
import { startHarness } from '../src/server';

const root = resolve(__dirname, '../../..');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/** A stand-in for the model, keyed on what was clicked, so the test controls exactly what an "edit" does. */
class Scripted implements LlmProvider {
  readonly name = 'scripted';
  calls: CompletionRequest[] = [];
  async complete(req: CompletionRequest) {
    this.calls.push(structuredClone(req));
    const user = req.messages[0]!.content;
    const shot = JSON.parse(/Current shot JSON:\n([\s\S]*?)\n\nObjects in/.exec(user)![1]!);
    if (user.includes('clicked: prop "yen"')) {
      shot.props = shot.props.map((p: { kind: string }) => (p.kind === 'counter' ? { ...p, prefix: '$' } : p));
    } else if (user.includes('clicked: set "sign_pachinko"')) {
      const current = JSON.parse(/Its current JSON: (.*)\n/.exec(user)![1]!);
      shot.setOverrides = { remove: [], objects: [{ ...current, text: 'CAT', position: [0.4, current.position[1], current.position[2]] }] };
    }
    return JSON.stringify(shot);
  }
}

/** Every file under dir, as text (history snapshots excluded). */
function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (f === '.shortstudio' || f === 'out') continue;
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}
const changedFiles = (a: Record<string, string>, b: Record<string, string>) => Object.keys({ ...a, ...b }).filter((f) => a[f] !== b[f]).sort();

describe('desktop UI: click-to-edit, end to end', () => {
  let browser: Browser;
  let page: Page;
  let close: () => Promise<void>;
  let dir: string;
  let bundle: ReturnType<typeof loadProject>['bundle'];
  const provider = new Scripted();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ui-'));
    cpSync(resolve(root, 'examples/props'), dir, { recursive: true });
    // a small project size keeps the export at the end quick
    const pj = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ ...pj, width: 216, height: 384 }, null, 2));
    bundle = loadProject(dir).bundle;

    const harness = await startHarness(new ProjectService({ provider: () => provider }));
    close = harness.close;
    browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    page.on('pageerror', (e) => console.error('[page error]', e.message));
    await page.goto(`${harness.url}?project=${encodeURIComponent(dir)}`);
    await page.waitForSelector('#stage-wrap.loaded', { timeout: 60_000 });
    await page.evaluate(() => (window as unknown as { __app: { seek(t: number): void } }).__app.seek(0.5));
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await close?.();
  });

  /** Click the screen position of a world point in shot_01 at t=0.5 (the page's seek). */
  async function clickWorld(shotId: string, t: number, p: [number, number, number]) {
    const shot = bundle.shots[shotId]!;
    const ndc = project(cameraAt(shot.camera, t - shot.start), p, 216 / 384)!;
    const rect = (await page.locator('#stage').boundingBox())!;
    await page.mouse.click(rect.x + ((ndc.x + 1) / 2) * rect.width, rect.y + ((1 - ndc.y) / 2) * rect.height);
  }
  const canvasPng = () => page.evaluate(() => (document.getElementById('stage') as HTMLCanvasElement).toDataURL('image/png'));
  const status = () => page.locator('#status').innerText();

  it('opens the project and shows it', async () => {
    expect(await page.locator('#project-name').innerText()).toBe('Props demo');
    expect(await page.locator('#time').innerText()).toMatch(/0\.50 \/ 8\.00 s/);
    expect(await page.locator('#ticks i').count()).toBe(5); // one tick per shot
  });

  it('clicking a prop selects it, names it, and draws the glowing box', async () => {
    const before = await canvasPng();
    await clickWorld('shot_01', 0.5, [0, 4.6, 0.3]);
    await page.waitForSelector('#edit-panel:not([hidden])');
    expect(await page.locator('#target-label').innerText()).toBe('Edit shot_01 → prop “yen”');
    expect(await canvasPng()).not.toBe(before); // the selection box
  });

  it('an edit is proposed with a diff and an instant preview, and NOTHING is saved yet', async () => {
    const onDisk = files(dir);
    const selected = await canvasPng();
    await page.locator('#prompt').fill('make the counter say dollars');
    await page.locator('#submit').click();
    await page.waitForSelector('#proposal:not([hidden])', { timeout: 60_000 });

    const diff = await page.locator('#diff').innerText();
    expect(diff).toContain('"prefix": "$"');
    expect(diff).toMatch(/- +"prefix": "¥"/);
    expect(await page.locator('#diff .add').count()).toBeGreaterThan(0);
    expect(await page.locator('#diff .del').count()).toBeGreaterThan(0);
    expect(await canvasPng()).not.toBe(selected); // the preview shows the new prefix
    expect(files(dir)).toEqual(onDisk); // unsaved
    expect(await status()).toMatch(/Nothing is saved until you press Apply/);
    // the model got this shot only
    const sent = provider.calls.at(-1)!.messages[0]!.content;
    expect(sent).toContain('"id": "shot_01"');
    expect(sent).not.toContain('shot_02');
  });

  it('discard brings the picture back and still saves nothing', async () => {
    const onDisk = files(dir);
    await page.locator('#discard').click();
    await page.waitForSelector('#proposal', { state: 'hidden' });
    expect(files(dir)).toEqual(onDisk);
    expect(await status()).toMatch(/Discarded/);
    expect(await page.locator('#history li.none').count()).toBe(1);
  });

  it('apply saves exactly one shot file, updates history, and the viewport keeps showing it', async () => {
    const before = files(dir);
    await page.locator('#prompt').fill('make the counter say dollars');
    await page.locator('#submit').click();
    await page.waitForSelector('#proposal:not([hidden])', { timeout: 60_000 });
    await page.locator('#apply').click();
    await page.waitForSelector('#proposal', { state: 'hidden' });
    await page.waitForFunction(() => document.querySelectorAll('#history li:not(.none)').length === 1);

    expect(changedFiles(before, files(dir))).toEqual(['shots/shot_01.json']);
    expect(JSON.parse(readFileSync(join(dir, 'shots/shot_01.json'), 'utf8')).props[0].prefix).toBe('$');
    expect(await status()).toMatch(/Only shots\/shot_01\.json changed/);
    expect(await page.locator('#history li').first().innerText()).toContain('shot_01 → prop “yen”: make the counter say dollars');
    expect(await page.locator('#undo').isEnabled()).toBe(true);
    expect(await page.locator('#redo').isEnabled()).toBe(false);
  });

  it('undo restores the file exactly; redo puts the edit back', async () => {
    const edited = files(dir);
    await page.locator('#undo').click();
    await page.waitForFunction(() => document.querySelector('#history li')?.classList.contains('undone'));
    expect(JSON.parse(readFileSync(join(dir, 'shots/shot_01.json'), 'utf8')).props[0].prefix).toBe('¥');
    expect(changedFiles(edited, files(dir))).toEqual(['shots/shot_01.json']);
    expect(await page.locator('#redo').isEnabled()).toBe(true);

    await page.locator('#redo').click();
    await page.waitForFunction(() => document.querySelector('#history li')?.classList.contains('undone') === false);
    expect(files(dir)).toEqual(edited);
  });

  it('clicking a character and a set object name them correctly', async () => {
    await page.keyboard.press('Escape');
    const ken = bundle.shots.shot_01!.actors.find((a) => a.id === 'ken')!;
    await clickWorld('shot_01', 0.5, [ken.position[0], 1.58, ken.position[2] + 0.45]);
    await page.waitForSelector('#edit-panel:not([hidden])');
    expect(await page.locator('#target-label').innerText()).toBe('Edit shot_01 → character “ken”');

    await page.keyboard.press('Escape');
    const sign = bundle.sets.neon_street!.objects.find((o) => o.id === 'sign_pachinko') as { position: [number, number, number] };
    await clickWorld('shot_01', 0.5, sign.position);
    expect(await page.locator('#target-label').innerText()).toBe('Edit shot_01 → set object “sign_pachinko”');
  });

  it('editing a set object changes ONLY this shot (setOverrides); the shared set and other shots are untouched', async () => {
    const before = files(dir);
    await page.locator('#prompt').fill('make the sign say CAT and nudge it right');
    await page.locator('#submit').click();
    await page.waitForSelector('#proposal:not([hidden])', { timeout: 60_000 });
    expect(await page.locator('#diff').innerText()).toContain('setOverrides');
    await page.locator('#apply').click();
    await page.waitForFunction(() => document.querySelectorAll('#history li:not(.none)').length >= 2);

    expect(changedFiles(before, files(dir))).toEqual(['shots/shot_01.json']); // not sets/neon_street.json, not shot_02..05
    const shot = JSON.parse(readFileSync(join(dir, 'shots/shot_01.json'), 'utf8'));
    expect(shot.setOverrides.objects[0]).toMatchObject({ id: 'sign_pachinko', text: 'CAT' });
    // the other shot that uses the same set still has the original sign
    expect(JSON.parse(readFileSync(join(dir, 'shots/shot_03.json'), 'utf8')).setOverrides ?? { objects: [] }).toMatchObject({ objects: [] });
  });

  it('scrubbing the timeline moves the picture and the clock', async () => {
    const a = await canvasPng();
    // a drag fires input events; fill() rejects values that are not a multiple of the slider's frame-sized step
    await page.locator('#timeline').evaluate((el: HTMLInputElement) => {
      el.value = '3';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(await page.locator('#time').innerText()).toMatch(/3\.00 \/ 8\.00 s/);
    expect(await canvasPng()).not.toBe(a);
  });

  it('an invalid instruction target is reported on screen, not as a crash', async () => {
    await page.evaluate(() => { (window as unknown as { __app: { seek(t: number): void } }).__app.seek(0.5); });
    await page.keyboard.press('Escape');
    await clickWorld('shot_01', 0.5, [0, 4.6, 0.3]);
    await page.locator('#prompt').fill('   ');
    await page.locator('#submit').click();
    expect(await status()).toMatch(/Say what to change first/);
  });

  it.skipIf(!hasFfmpeg)('exports an MP4 from the UI: H.264 video, an AAC track, and the mix summary', async () => {
    await page.keyboard.press('Escape');
    await page.locator('#export').click();
    await page.waitForFunction(() => /^Exported /.test(document.getElementById('status')!.textContent ?? ''), null, { timeout: 200_000 });
    const out = join(dir, 'out', `${dir.split('/').pop()}.mp4`);
    const p = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', out], { encoding: 'utf8' });
    const streams = (JSON.parse(p.stdout) as { streams: Record<string, string>[] }).streams;
    expect(streams.find((s) => s.codec_type === 'video')).toMatchObject({ codec_name: 'h264', width: 216, height: 384 });
    expect(streams.find((s) => s.codec_type === 'audio')?.codec_name).toBe('aac');
    expect(await status()).toMatch(/master -?\d+\.\d LUFS/);
  }, 260_000);
}, 600_000);
