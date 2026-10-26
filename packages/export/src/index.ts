/**
 * In-engine video export: WebCodecs VideoEncoder + mp4-muxer, no screen capture and no wall clock.
 * Frame N is rendered at t = N / fps by the caller's `renderFrame`, handed to the encoder as a VideoFrame with an
 * exact microsecond timestamp, and muxed into an MP4. Audio is mixed separately (see @shortstudio/audio) and
 * attached afterwards, so the same code runs in the headless renderer and in the desktop app.
 */
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';

export type MuxCodec = 'avc' | 'vp9' | 'av1';

/** Candidate encoder configurations, best first. H.264 is what TikTok and YouTube Shorts expect. */
export const CODEC_PREFERENCE: { codec: string; mux: MuxCodec }[] = [
  { codec: 'avc1.64002a', mux: 'avc' }, // High, level 4.2 (1080x1920 at 60fps)
  { codec: 'avc1.640028', mux: 'avc' }, // High, level 4.0
  { codec: 'avc1.4d002a', mux: 'avc' }, // Main, level 4.2
  { codec: 'vp09.00.50.08', mux: 'vp9' },
  { codec: 'vp09.00.40.08', mux: 'vp9' },
  { codec: 'av01.0.08M.08', mux: 'av1' },
];

export interface ExportOptions {
  width: number;
  height: number;
  fps: number;
  frames: number;
  /** Renders frame `index` (t = index / fps) onto `canvas`. */
  renderFrame: (index: number) => void;
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** bits per second; default scales with pixel count and fps. */
  bitrate?: number;
  /** A keyframe at least this often, seconds. */
  keyframeEvery?: number;
  onProgress?: (done: number, total: number) => void;
  /** Force a specific encoder string (must be supported). */
  codec?: string;
}

export interface ExportResult {
  bytes: Uint8Array;
  codec: string;
  mux: MuxCodec;
  frames: number;
}

/** Bitrate that keeps flat-shaded 3D clean without bloating the file. */
export const defaultBitrate = (w: number, h: number, fps: number): number => Math.round(w * h * fps * 0.09);

export async function pickCodec(w: number, h: number, fps: number, bitrate: number, wanted?: string): Promise<{ codec: string; mux: MuxCodec }> {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('WebCodecs VideoEncoder is not available here (it needs a secure context: https or localhost)');
  }
  const list = wanted ? CODEC_PREFERENCE.filter((c) => c.codec === wanted) : CODEC_PREFERENCE;
  for (const c of list) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec: c.codec, width: w, height: h, bitrate, framerate: fps });
      if (r.supported) return c;
    } catch {
      /* try the next one */
    }
  }
  throw new Error(`no supported video encoder for ${w}x${h}@${fps} (tried ${list.map((c) => c.codec).join(', ')})`);
}

export async function exportVideo(o: ExportOptions): Promise<ExportResult> {
  if (o.width % 2 || o.height % 2) throw new Error(`video size must be even, got ${o.width}x${o.height}`);
  const bitrate = o.bitrate ?? defaultBitrate(o.width, o.height, o.fps);
  const { codec, mux } = await pickCodec(o.width, o.height, o.fps, bitrate, o.codec);

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: mux, width: o.width, height: o.height, frameRate: o.fps }, fastStart: 'in-memory' });
  let failure: Error | undefined;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      failure = e;
    },
  });
  encoder.configure({ codec, width: o.width, height: o.height, bitrate, framerate: o.fps, latencyMode: 'quality' });

  const keyEvery = Math.max(1, Math.round((o.keyframeEvery ?? 2) * o.fps));
  const frameUs = 1e6 / o.fps;
  for (let f = 0; f < o.frames; f++) {
    if (failure) throw failure;
    o.renderFrame(f);
    const frame = new VideoFrame(o.canvas, { timestamp: Math.round(f * frameUs), duration: Math.round(frameUs) });
    encoder.encode(frame, { keyFrame: f % keyEvery === 0 });
    frame.close();
    // backpressure: do not let rendered frames pile up faster than the encoder can take them
    while (encoder.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 1));
    o.onProgress?.(f + 1, o.frames);
  }
  await encoder.flush();
  if (failure) throw failure;
  encoder.close();
  muxer.finalize();
  return { bytes: new Uint8Array(target.buffer), codec, mux, frames: o.frames };
}
