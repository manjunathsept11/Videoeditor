/**
 * The real Electron app: the built main process, the preload bridge over real IPC, the built renderer loaded from file://
 * under its Content-Security-Policy, and a real model subprocess (a stand-in CLI) behind the settings.
 * Needs a display: on headless Linux run it as `xvfb-run -a npm run test:e2e`.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cameraAt, project } from '@shortstudio/qa';
import { loadProject } from '../../render/project';

const root = resolve(__dirname, '../../..');
const hasDisplay = Boolean(process.env.DISPLAY);
const built = existsSync(join(root, 'apps/desktop/dist-electron/main.cjs')) && existsSync(join(root, 'apps/desktop/dist-renderer/index.html'));
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

const FAKE_CLI = `
let s = '';
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  const shot = JSON.parse(/Current shot JSON:\\n([\\s\\S]*?)\\n\\nObjects in/.exec(s)[1]);
  shot.props = shot.props.map((p) => (p.kind === 'counter' ? { ...p, prefix: '$' } : p));
  process.stdout.write('Here is the edited shot:\\n\`\`\`json\\n' + JSON.stringify(shot) + '\\n\`\`\`\\n');
});
`;

function listFiles(dir: string, skip = new Set(['.shortstudio', 'out'])): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (skip.has(f)) continue;
      if (statSync(p).isDirectory()) walk(p);
      else out[p.slice(dir.length + 1)] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

describe.skipIf(!hasDisplay || !built)('Electron app', () => {
  let app: ElectronApplication;
  let page: Page;
  let proj: string;
  let userData: string;
  let exportPath: string;
  let bundle: ReturnType<typeof loadProject>['bundle'];
  const errors: string[] = [];

  beforeAll(async () => {
    const work = mkdtempSync(join(tmpdir(), 'electron-'));
    proj = join(work, 'project');
    userData = join(work, 'userdata');
    exportPath = join(work, 'exported', 'short.mp4');
    cpSync(resolve(root, 'examples/props'), proj, { recursive: true });
    const pj = JSON.parse(readFileSync(join(proj, 'project.json'), 'utf8'));
    writeFileSync(join(proj, 'project.json'), JSON.stringify({ ...pj, width: 216, height: 384 }));
    writeFileSync(join(work, 'fake-llm.cjs'), FAKE_CLI);
    bundle = loadProject(proj).bundle;

    const env = { ...process.env } as Record<string, string>;
    delete env.NODE_OPTIONS; // the sandbox's --use-openssl-ca is not valid inside Electron
    // SHORTSTUDIO_E2E_EXECUTABLE points at an electron-builder output (release/linux-unpacked/ShortStudio) to test the
    // packaged app itself: asar layout, unpacked ffmpeg, packaged paths. Otherwise run the built app under the electron binary.
    const packaged = process.env.SHORTSTUDIO_E2E_EXECUTABLE;
    const electronPath = packaged ?? ((await import('electron')).default as unknown as string);
    app = await electron.launch({
      executablePath: electronPath,
      args: [...(packaged ? [] : [join(root, 'apps/desktop')]), '--no-sandbox', `--user-data-dir=${userData}`],
      env: {
        ...env,
        SHORTSTUDIO_SOFTWARE_GL: '1',
        SHORTSTUDIO_TEST_PROJECT: proj,
        SHORTSTUDIO_TEST_EXPORT: exportPath,
        SHORTSTUDIO_TEST_SETTINGS: JSON.stringify({ provider: 'cli', cliCommand: process.execPath, cliArgs: join(work, 'fake-llm.cjs') }),
      },
    });
    page = await app.firstWindow();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.waitForSelector('#open', { timeout: 60_000 });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  const click = async (t: number, p: [number, number, number]) => {
    const shot = bundle.shots.shot_01!;
    const ndc = project(cameraAt(shot.camera, t - shot.start), p, 216 / 384)!;
    const r = (await page.locator('#stage').boundingBox())!;
    await page.mouse.click(r.x + ((ndc.x + 1) / 2) * r.width, r.y + ((1 - ndc.y) / 2) * r.height);
  };

  it('the page has the bridge and nothing else: no Node, no require, a strict CSP', async () => {
    const r = await page.evaluate(() => ({
      bridge: typeof (window as unknown as { shortstudio?: { call: unknown } }).shortstudio?.call,
      hasRequire: typeof (window as unknown as { require?: unknown }).require,
      hasProcess: typeof (window as unknown as { process?: unknown }).process,
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '',
      protocol: location.protocol,
    }));
    expect(r.bridge).toBe('function');
    expect(r.hasRequire).toBe('undefined');
    expect(r.hasProcess).toBe('undefined');
    expect(r.protocol).toBe('file:');
    expect(r.csp).toContain("default-src 'self'");
    expect(r.csp).toContain("connect-src 'self'");
    expect(r.csp).toContain("object-src 'none'");
  });

  it('refuses a service method that is not on the allow-list', async () => {
    const msg = await page.evaluate(async () => {
      try {
        await (window as unknown as { shortstudio: { call(m: string, ...a: unknown[]): Promise<unknown> } }).shortstudio.call('constructor');
        return 'allowed';
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(msg).toMatch(/unknown method "constructor"/);
  });

  it('Open project goes through the native-dialog hook, loads the project and renders it', async () => {
    await page.locator('#open').click();
    await page.waitForSelector('#stage-wrap.loaded', { timeout: 60_000 });
    expect(await page.locator('#project-name').innerText()).toBe('Props demo');
    await page.evaluate(() => (window as unknown as { __app: { seek(t: number): void } }).__app.seek(0.5));
    expect(await page.evaluate(() => (document.getElementById('stage') as HTMLCanvasElement).toDataURL().length)).toBeGreaterThan(5000);
  });

  it('click-to-edit through real IPC and a real model subprocess: diff, apply, exactly one file changed', async () => {
    const before = listFiles(proj);
    await click(0.5, [0, 4.6, 0.3]);
    await page.waitForSelector('#edit-panel:not([hidden])');
    expect(await page.locator('#target-label').innerText()).toBe('Edit shot_01 → prop “yen”');
    await page.locator('#prompt').fill('make the counter say dollars');
    await page.locator('#submit').click();
    await page.waitForSelector('#proposal:not([hidden])', { timeout: 60_000 });
    expect(await page.locator('#diff').innerText()).toContain('"prefix": "$"');
    expect(listFiles(proj)).toEqual(before); // still unsaved

    await page.locator('#apply').click();
    await page.waitForFunction(() => document.querySelectorAll('#history li:not(.none)').length === 1);
    const after = listFiles(proj);
    expect(Object.keys(after).filter((f) => after[f] !== before[f])).toEqual(['shots/shot_01.json']);
    expect(JSON.parse(after['shots/shot_01.json']!).props[0].prefix).toBe('$');
  }, 90_000);

  it('undo works over IPC and restores the file', async () => {
    await page.locator('#undo').click();
    await page.waitForFunction(() => document.querySelector('#history li')?.classList.contains('undone'));
    expect(JSON.parse(readFileSync(join(proj, 'shots/shot_01.json'), 'utf8')).props[0].prefix).toBe('¥');
  });

  it('settings persist to the user-data folder, and an API key is never written in plain text', async () => {
    await page.locator('#settings').click();
    await page.locator('#s-provider').selectOption('api');
    await page.locator('#s-key').fill('sk-ant-test-SECRET-123');
    await page.locator('#s-save').click();
    await page.waitForFunction(() => /Settings saved/.test(document.getElementById('status')!.textContent ?? ''));
    const saved = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'));
    expect(saved.provider).toBe('api');
    for (const [name, text] of Object.entries(listFiles(userData, new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'Local Storage', 'Session Storage', 'Network', 'Shared Dictionary', 'blob_storage', 'Partitions'])))) {
      expect(text, name).not.toContain('SECRET-123');
    }
    // and the page cannot read it back
    const view = await page.evaluate(() => (window as unknown as { shortstudio: { call(m: string): Promise<Record<string, unknown>> } }).shortstudio.call('getSettings'));
    expect(JSON.stringify(view)).not.toContain('SECRET');
    expect(view.hasApiKey).toBe(true);
  });

  it.skipIf(!hasFfmpeg)('exports an MP4 from the app: WebCodecs video, the bundled-ffmpeg mux, an audio track', async () => {
    await page.locator('#export').click();
    await page.waitForFunction(() => /^Exported /.test(document.getElementById('status')!.textContent ?? ''), null, { timeout: 200_000 });
    expect(existsSync(exportPath)).toBe(true);
    const p = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', exportPath], { encoding: 'utf8' });
    const streams = (JSON.parse(p.stdout) as { streams: Record<string, string>[] }).streams;
    expect(streams.find((s) => s.codec_type === 'video')).toMatchObject({ width: 216, height: 384 });
    expect(streams.find((s) => s.codec_type === 'audio')?.codec_name).toBe('aac');
  }, 260_000);

  it('raised no page errors (a blocked script or a failed import would show up here)', () => {
    expect(errors.filter((e) => !/dbus|GPU process|vaapi|ERR_CERT/i.test(e))).toEqual([]);
  });
}, 900_000);
