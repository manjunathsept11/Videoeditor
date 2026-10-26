import { spawnSync } from 'node:child_process';

export const SAMPLE_RATE = 48000;

/** Decode any audio file ffmpeg understands to mono float samples at 48kHz. */
export function decodeAudio(path: string, sampleRate = SAMPLE_RATE): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-'], {
    maxBuffer: 1 << 30,
  });
  if (r.status !== 0) throw new Error(`ffmpeg failed to decode ${path}: ${r.stderr?.toString() ?? r.error}`);
  const buf = r.stdout;
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

/** 16-bit PCM mono WAV. */
export function encodeWav16(samples: Float32Array, sampleRate = SAMPLE_RATE): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    data.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** 16-bit PCM stereo WAV from two channels. */
export function encodeWavStereo16(left: Float32Array, right: Float32Array, sampleRate = SAMPLE_RATE): Buffer {
  const n = Math.min(left.length, right.length);
  const data = Buffer.alloc(n * 4);
  const q = (v: number) => {
    const c = Math.max(-1, Math.min(1, v));
    return Math.round(c < 0 ? c * 0x8000 : c * 0x7fff);
  };
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(q(left[i]!), i * 4);
    data.writeInt16LE(q(right[i]!), i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
