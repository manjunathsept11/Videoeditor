import type { ServiceApi } from '../src/api';

/** What the Electron preload script provides. In a plain browser (the test harness) the HTTP bridge below stands in. */
export interface HostBridge {
  call(method: string, ...args: unknown[]): Promise<unknown>;
  pickProjectDir?(): Promise<string | null>;
  pickExportPath?(defaultPath: string): Promise<string | null>;
}

declare global {
  interface Window {
    shortstudio?: HostBridge;
  }
}

const http: HostBridge = {
  async call(method, ...args) {
    const res = await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }) });
    const json = (await res.json()) as { ok: boolean; result?: unknown; error?: string };
    if (!json.ok) throw new Error(json.error);
    return json.result;
  },
};

export const host: HostBridge = window.shortstudio ?? http;

/** The service, as if it were local. Every method is an async call across whichever transport is in use. */
export const service = new Proxy({} as ServiceApi, {
  get: (_t, method: string) => (...args: unknown[]) => host.call(method, ...args),
});

/** Electron wraps remote errors ("Error invoking remote method 'svc': Error: ..."); show just the message. */
export const messageOf = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
