import { describe, expect, it } from 'vitest';
import { CODEC_PREFERENCE, defaultBitrate, exportVideo, pickCodec } from '../src/index';

describe('export (no WebCodecs in Node)', () => {
  it('prefers H.264, then VP9, then AV1', () => {
    expect(CODEC_PREFERENCE.map((c) => c.mux)).toEqual(['avc', 'avc', 'avc', 'vp9', 'vp9', 'av1']);
    expect(CODEC_PREFERENCE[0]!.codec.startsWith('avc1.64')).toBe(true);
  });
  it('scales bitrate with pixels and frame rate', () => {
    expect(defaultBitrate(1080, 1920, 60)).toBe(2 * defaultBitrate(1080, 1920, 30));
    expect(defaultBitrate(1080, 1920, 30)).toBeGreaterThan(5e6);
    expect(defaultBitrate(1080, 1920, 30)).toBeLessThan(2e7);
  });
  it('explains itself when WebCodecs is unavailable instead of failing obscurely', async () => {
    await expect(pickCodec(1080, 1920, 30, 8e6)).rejects.toThrow(/secure context/);
  });
  it('rejects odd sizes before doing any work', async () => {
    await expect(exportVideo({ width: 1081, height: 1920, fps: 30, frames: 1, renderFrame: () => {}, canvas: {} as never })).rejects.toThrow(/even/);
  });
});
