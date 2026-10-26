import { Studio } from '@shortstudio/engine';
import type { Bundle } from '@shortstudio/schema';

declare global {
  interface Window {
    studioApi: {
      init(width: number, height: number, bundle: Bundle): number;
      renderAt(t: number, mime: string): string;
    };
  }
}

let studio: Studio | undefined;
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
};
(window as unknown as { ready: boolean }).ready = true;
