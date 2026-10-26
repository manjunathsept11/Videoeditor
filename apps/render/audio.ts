/**
 * Voiceover tooling.
 *
 *   npm run audio -- tighten <in.wav> <out.wav> [--max 0.2] [--threshold -40]
 *       Clamp every pause to --max seconds; writes <out.wav> and <out.wav>.map.json
 *   npm run audio -- import-whisper <whisper.json> <alignment.json> [--audio tight.wav] [--map out.wav.map.json]
 *       Convert WhisperX / whisper-timestamped word timestamps into alignment.json.
 *       Pass --map when the words were timed on the ORIGINAL audio.
 *   npm run audio -- mix <projectDir> <master.wav> [--music file.wav] [--no-sfx] [--no-auto]
 *       Mix voiceover + effects + music to a -14 LUFS stereo master and print the levels.
 *   npm run audio -- check <projectDir>
 *       Resolve word anchors and print the timeline (seconds and 30fps frames).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CANONICAL_FPS } from '@shortstudio/schema';
import { SAMPLE_RATE, clampSilences, decodeAudio, encodeWav16, encodeWavStereo16, importWhisperJson, remapAlignment, type Segment } from '@shortstudio/audio';
import { describeMix, mixProject } from './mixproject';
import { loadProject } from './project';

const a = process.argv.slice(2);
const cmd = a.shift();
const pos: string[] = [];
const opt: Record<string, string> = {};
for (let i = 0; i < a.length; i++) a[i]!.startsWith('--') ? (opt[a[i]!.slice(2)] = a[++i] ?? '') : pos.push(a[i]!);

const frame = (t: number) => Math.round(t * CANONICAL_FPS);

if (cmd === 'tighten') {
  const [input, output] = pos;
  if (!input || !output) throw new Error('usage: tighten <in> <out.wav> [--max s] [--threshold dB]');
  const samples = decodeAudio(input);
  const r = clampSilences(samples, SAMPLE_RATE, { maxSilence: Number(opt.max ?? 0.2), thresholdDb: Number(opt.threshold ?? -40) });
  writeFileSync(output, encodeWav16(r.samples));
  writeFileSync(`${output}.map.json`, JSON.stringify({ sampleRate: SAMPLE_RATE, map: r.map }, null, 2));
  console.log(`${(samples.length / SAMPLE_RATE).toFixed(2)}s -> ${(r.samples.length / SAMPLE_RATE).toFixed(2)}s (removed ${r.removed.toFixed(2)}s of silence) -> ${output}`);
} else if (cmd === 'import-whisper') {
  const [input, output] = pos;
  if (!input || !output) throw new Error('usage: import-whisper <whisper.json> <alignment.json> [--audio tight.wav] [--map file]');
  const duration = opt.audio ? decodeAudio(opt.audio).length / SAMPLE_RATE : undefined;
  let alignment = importWhisperJson(JSON.parse(readFileSync(input, 'utf8')), duration);
  if (opt.map) {
    const { map } = JSON.parse(readFileSync(opt.map, 'utf8')) as { map: Segment[] };
    alignment = remapAlignment(alignment, map, duration);
  }
  writeFileSync(output, JSON.stringify(alignment, null, 2));
  console.log(`${alignment.words.length} words -> ${output}`);
} else if (cmd === 'mix') {
  const [dir, out] = pos;
  if (!dir || !out) throw new Error('usage: mix <projectDir> <master.wav> [--music file] [--no-sfx] [--no-auto] [--max-sfx n]');
  const { bundle, voiceover } = loadProject(dir);
  const m = mixProject(dir, bundle, voiceover, { music: opt.music, noAuto: 'no-auto' in opt, noSfx: 'no-sfx' in opt, maxSfxPerMinute: opt['max-sfx'] ? Number(opt['max-sfx']) : undefined });
  for (const l of describeMix(m)) console.log(l);
  if (!m.hasAudio) throw new Error('nothing to mix: no voiceover, effects or music');
  writeFileSync(out, encodeWavStereo16(m.master, m.master));
  writeFileSync(`${out}.json`, JSON.stringify(m.report, (_, v) => (v === -Infinity ? null : v), 2));
  console.log(`wrote ${out} and ${out}.json`);
} else if (cmd === 'check') {
  const [dir] = pos;
  if (!dir) throw new Error('usage: check <projectDir>');
  const { bundle, voiceover } = loadProject(dir);
  console.log(`${bundle.project.name}  voiceover: ${voiceover ?? '(none)'}`);
  for (const id of bundle.project.shots) {
    const s = bundle.shots[id]!;
    console.log(`\n${s.id}  ${s.start.toFixed(3)}s (f${frame(s.start)}) +${s.duration.toFixed(3)}s  set=${s.set}  in=${s.transitionIn.type}`);
    for (const e of s.events) {
      const detail =
        e.type === 'gesture' ? `${e.gesture}/${e.hand}` : e.type === 'expression' ? e.expression : e.type === 'walk' ? `-> (${e.to}) by ${e.until.toFixed(2)}s` : `${e.height * 100}% head`;
      console.log(`   ${e.type.padEnd(10)} ${e.actor.padEnd(5)} ${detail.padEnd(12)} word@${e.at.toFixed(3)}s (f${frame(e.at)})`);
    }
    for (const e of s.propEvents) {
      const what = e.value !== undefined ? `-> ${e.value}` : e.time ? `-> ${e.time}` : `-> lens (${e.to})`;
      console.log(`   prop       ${e.prop.padEnd(5)} ${what.padEnd(12)} lands@${e.at.toFixed(3)}s (f${frame(e.at)})`);
    }
  }
} else {
  throw new Error('commands: tighten | import-whisper | mix | check');
}
