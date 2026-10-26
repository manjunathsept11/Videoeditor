import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Plugin } from 'vite';
import type { ServiceApi } from './api';

const METHODS = new Set<keyof ServiceApi>(['open', 'proposeEdit', 'acceptEdit', 'rejectEdit', 'undo', 'redo', 'history', 'getSettings', 'saveSettings', 'defaultExportPath', 'exportStart', 'exportChunk', 'exportFinish']);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** The HTTP transport: POST /api/<method> {args: [...]} -> {ok, result|error}. Same service the Electron IPC serves. */
export function apiPlugin(service: ServiceApi): Plugin {
  return {
    name: 'shortstudio-api',
    configureServer(server) {
      server.middlewares.use('/api', async (req: IncomingMessage, res: ServerResponse) => {
        const reply = (code: number, body: unknown) => {
          res.statusCode = code;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };
        try {
          const method = (req.url ?? '').replace(/^\//, '').split('?')[0] as keyof ServiceApi;
          if (!METHODS.has(method)) return reply(404, { ok: false, error: `unknown method "${method}"` });
          const { args } = JSON.parse(await readBody(req)) as { args: unknown[] };
          const result = await (service[method] as (...a: unknown[]) => Promise<unknown>)(...args);
          reply(200, { ok: true, result });
        } catch (e) {
          reply(200, { ok: false, error: (e as Error).message });
        }
      });
    },
  };
}

/** Serve the renderer plus the API over HTTP: how the UI is exercised in a plain browser. */
export async function startHarness(service: ServiceApi, port = 0): Promise<{ url: string; close(): Promise<void> }> {
  const server = await createServer({ configFile: new URL('../vite.config.ts', import.meta.url).pathname, plugins: [apiPlugin(service)], server: { port, host: '127.0.0.1' }, logLevel: 'error' });
  await server.listen();
  return { url: server.resolvedUrls!.local[0]!, close: () => server.close() };
}
