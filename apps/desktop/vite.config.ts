import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

/** The packaged page may load only its own files: no remote scripts, no connections out, no plugins. (Dev serves without it so HMR works.) */
const csp: Plugin = {
  name: 'shortstudio-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace(
      '<head>',
      `<head>\n  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'" />`,
    ),
};

/** The renderer: served by Vite in dev and in the test harness, built to dist-renderer for the packaged app (loaded from file://). */
export default defineConfig({
  root: resolve(here, 'renderer'),
  base: './',
  plugins: [csp],
  build: { outDir: resolve(here, 'dist-renderer'), emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 2500 },
  server: { fs: { allow: [resolve(here, '../..')] } },
});
