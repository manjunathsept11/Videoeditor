import { spawnSync } from 'node:child_process';

export const SAMPLE_RATE = 48000;

/** Decode any audio file ffmpeg understands to mono float samples at 48kHz. */
export function decodeAudio(path: string, sampleRate = SAMPLE_RATE): Float32Array {
  const r = spawnSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-'], {
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

export interface DecodedWav {
  /** Mono float samples (stereo is averaged). */
  samples: Float32Array;
  sampleRate: number;
}

/**
 * Parse an in-memory RIFF/WAVE (PCM 8/16/24/32-bit or 32-bit float, any channel count) without ffmpeg. Streamed WAVs
 * (what `espeak-ng --stdout` writes) can carry a bogus data length, so the data chunk is clamped to the bytes present.
 */
export function parseWav(buf: Buffer): DecodedWav {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let fmt: { format: number; channels: number; rate: number; bits: number } | undefined;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    let size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(body);
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24); // WAVE_FORMAT_EXTENSIBLE: sub-format
      fmt = { format, channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before fmt chunk');
      size = Math.min(size, buf.length - body);
      const bytes = fmt.bits / 8;
      const frames = Math.floor(size / (bytes * fmt.channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) {
          const o = body + (i * fmt.channels + c) * bytes;
          let v: number;
          if (fmt.format === 3 && fmt.bits === 32) v = buf.readFloatLE(o);
          else if (fmt.format === 1 && fmt.bits === 16) v = buf.readInt16LE(o) / 32768;
          else if (fmt.format === 1 && fmt.bits === 8) v = (buf.readUInt8(o) - 128) / 128;
          else if (fmt.format === 1 && fmt.bits === 24) v = buf.readIntLE(o, 3) / 8388608;
          else if (fmt.format === 1 && fmt.bits === 32) v = buf.readInt32LE(o) / 2147483648;
          else throw new Error(`unsupported WAV encoding: format ${fmt.format}, ${fmt.bits}-bit`);
          sum += v;
        }
        out[i] = sum / fmt.channels;
      }
      return { samples: out, sampleRate: fmt.rate };
    }
    pos = body + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

/**
 * Windowed-sinc resampler (16 taps each side, Hann window). Low-passes when downsampling so nothing aliases.
 * Good enough for speech at any ratio; the pipeline's working rate is 48 kHz.
 */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const ratio = from / to;
  const n = Math.max(1, Math.round(x.length / ratio));
  const out = new Float32Array(n);
  const cutoff = Math.min(1, to / from);
  const half = 16;
  for (let i = 0; i < n; i++) {
    const t = i * ratio;
    const c = Math.floor(t);
    let acc = 0;
    for (let k = c - half + 1; k <= c + half; k++) {
      if (k < 0 || k >= x.length) continue;
      const d = (t - k) * cutoff;
      const sinc = Math.abs(d) < 1e-9 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
      const w = 0.5 * (1 + Math.cos((Math.PI * (t - k)) / half));
      acc += x[k]! * sinc * w * cutoff;
    }
    out[i] = acc;
  }
  return out;
}
