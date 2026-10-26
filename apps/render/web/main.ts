import { Studio } from '@shortstudio/engine';
import { exportVideo } from '@shortstudio/export';
import type { Bundle } from '@shortstudio/schema';

interface ExportSummary {
  codec: string;
  mux: string;
  frames: number;
  bytes: number;
}

declare global {
  interface Window {
    studioApi: {
      init(width: number, height: number, bundle: Bundle): number;
      renderAt(t: number, mime: string): string;
      /** WebCodecs export of the whole project at `fps`; fetch the result with readChunk. */
      exportVideo(opts: { fps: number; bitrate?: number; codec?: string }): Promise<ExportSummary>;
      readChunk(offset: number, length: number): string;
      progress(): { done: number; total: number };
    };
  }
}

let studio: Studio | undefined;
let exported: Uint8Array | undefined;
let progress = { done: 0, total: 0 };
const canvas = document.getElementById('stage') as HTMLCanvasElement;

window.studioApi = {
  init(width, height, bundle) {
    studio = new Studio(canvas, width, height);
    studio.load(bundle);
    return studio.duration;
  },
  renderAt(t, mime) {
    studio!.renderAt(t);
    return canvas.toDataURL(mime, 0.95).split(',')[1]!;
  },
  async exportVideo({ fps, bitrate, codec }) {
    const s = studio!;
    const frames = Math.round(s.duration * fps);
    progress = { done: 0, total: frames };
    const r = await exportVideo({
      width: s.width, height: s.height, fps, frames, bitrate, codec, canvas,
      renderFrame: (f) => s.renderAt(f / fps), // frame N is always t = N / fps
      onProgress: (done, total) => (progress = { done, total }),
    });
    exported = r.bytes;
    return { codec: r.codec, mux: r.mux, frames: r.frames, bytes: r.bytes.length };
  },
  readChunk(offset, length) {
    const part = exported!.subarray(offset, offset + length);
    let bin = '';
    for (let i = 0; i < part.length; i += 0x8000) bin += String.fromCharCode(...part.subarray(i, i + 0x8000));
    return btoa(bin);
  },
  progress: () => progress,
};
(window as unknown as { ready: boolean }).ready = true;
