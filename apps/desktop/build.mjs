// Bundles the Electron main process and preload (CommonJS) with esbuild. The renderer is built by Vite.
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  // electron is provided by the runtime; ffmpeg-static must stay a real file on disk to be executable
  external: ['electron', 'ffmpeg-static'],
};
await build({ ...common, entryPoints: [join(here, 'src/main.ts')], outfile: join(here, 'dist-electron/main.cjs') });
await build({ ...common, entryPoints: [join(here, 'src/preload.ts')], outfile: join(here, 'dist-electron/preload.cjs') });
