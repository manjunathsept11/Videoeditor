import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { createServer } from 'vite';
import type { Bundle } from '@shortstudio/schema';

const here = dirname(fileURLToPath(import.meta.url));

export interface StudioSession {
  page: Page;
  /** Project length in seconds. */
  duration: number;
  close(): Promise<void>;
}

/**
 * Serve the render page, open it in headless Chromium and load a project into the engine.
 * The origin is http://127.0.0.1, a secure context, which WebCodecs requires.
 */
export async function openStudio(bundle: Bundle, width: number, height: number): Promise<StudioSession> {
  const server = await createServer({ root: join(here, 'web'), server: { port: 0, host: '127.0.0.1' }, logLevel: 'error', configFile: false });
  await server.listen();
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('pageerror', (e) => console.error('[page error]', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
    await page.goto(server.resolvedUrls!.local[0]!);
    await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true);
    const duration = await page.evaluate(([w, h, b]) => window.studioApi.init(w as number, h as number, b as never), [width, height, bundle] as const);
    await page.evaluate(() => document.fonts.ready);
    return {
      page,
      duration,
      close: async () => {
        await browser.close();
        await server.close();
      },
    };
  } catch (e) {
    await browser.close();
    await server.close();
    throw e;
  }
}

export function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const opt: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) pos.push(a);
    else if (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) opt[a.slice(2)] = argv[++i]!;
    else opt[a.slice(2)] = '';
  }
  return { pos, opt };
}
