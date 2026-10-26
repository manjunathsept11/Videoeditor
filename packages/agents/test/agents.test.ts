import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Alignment } from '@shortstudio/schema';
import { CliProvider, GenerationError, SHOT_SYSTEM, extractJson, generateValidated, produceProject, type CompletionRequest, type LlmProvider } from '../src/index';

// ---------------------------------------------------------------- json extraction
describe('extractJson', () => {
  it('handles fences, chatter and braces inside strings', () => {
    expect(extractJson('Sure!\n```json\n{"a": 1}\n```\nHope that helps')).toEqual({ a: 1 });
    expect(extractJson('here you go: {"s": "a } b { c", "n": [1,2]} trailing')).toEqual({ s: 'a } b { c', n: [1, 2] });
    expect(extractJson('{"q": "say \\"hi\\" }"}')).toEqual({ q: 'say "hi" }' });
  });
  it('throws when there is no JSON or it is cut off', () => {
    expect(() => extractJson('no json here')).toThrow(/no JSON/);
    expect(() => extractJson('{"a": [1, 2')).toThrow(/no JSON/);
  });
});

// ------------------------------------------------------- scripted test double
class Scripted implements LlmProvider {
  readonly name = 'scripted';
  calls: CompletionRequest[] = [];
  constructor(private respond: (req: CompletionRequest, n: number) => string) {}
  async complete(req: CompletionRequest) {
    this.calls.push(structuredClone(req));
    return this.respond(req, this.calls.length);
  }
}

describe('generateValidated', () => {
  const schema = z.object({ n: z.number() });
  it('feeds schema and semantic problems back and returns the repaired value', async () => {
    const p = new Scripted((_, n) => (n === 1 ? '{"n": "three"}' : n === 2 ? '{"n": 3}' : '{"n": 4}'));
    const v = await generateValidated({ provider: p, what: 'num', system: 's', user: 'u', schema, check: (x) => (x.n % 2 === 0 ? [] : ['n must be even']) });
    expect(v.n).toBe(4);
    expect(p.calls).toHaveLength(3);
    expect(p.calls[1]!.messages.at(-1)!.content).toMatch(/n: .*number/);   // schema issue shown
    expect(p.calls[2]!.messages.at(-1)!.content).toMatch(/n must be even/); // semantic issue shown
    expect(p.calls[2]!.messages).toHaveLength(5);                            // history keeps its own earlier answers
  });
  it('gives up with every problem listed', async () => {
    const p = new Scripted(() => 'not json');
    await expect(generateValidated({ provider: p, what: 'num', system: 's', user: 'u', schema, maxAttempts: 2 })).rejects.toThrow(GenerationError);
    expect(p.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- CLI provider
describe('CliProvider', () => {
  const script = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    const f = join(dir, 'fake-llm.mjs');
    writeFileSync(f, `#!/usr/bin/env node\n${body}`);
    chmodSync(f, 0o755);
    return f;
  };
  it('sends the flattened conversation on stdin and returns stdout', async () => {
    const f = script(`let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write('GOT:'+s.includes('<instructions>')+s.includes('hello user')));`);
    const out = await new CliProvider({ command: f, args: [] }).complete({ system: 'be brief', messages: [{ role: 'user', content: 'hello user' }] });
    expect(out).toBe('GOT:truetrue');
  });
  it('reports non-zero exit with stderr', async () => {
    const f = script(`console.error('boom');process.exit(3)`);
    await expect(new CliProvider({ command: f, args: [] }).complete({ system: '', messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/exited 3: boom/);
  });
  it('reports a missing executable clearly', async () => {
    await expect(new CliProvider({ command: 'definitely-not-installed-xyz' }).complete({ system: '', messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/could not run/);
  });
  it('times out', async () => {
    const f = script(`setTimeout(()=>{},10000)`);
    await expect(new CliProvider({ command: f, args: [], timeoutMs: 200 }).complete({ system: '', messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/timed out/);
  });
});

// ----------------------------------------------------------------- full pipeline
const alignment = Alignment.parse({
  duration: 4,
  words: [
    ['Japan', 0.1, 0.5], ['bans', 0.5, 0.9], ['gambling', 0.9, 1.5], ['But', 1.7, 1.9], ['the', 1.9, 2.0],
    ['prize', 2.0, 2.4], ['counter', 2.4, 2.9], ['makes', 3.0, 3.3], ['it', 3.3, 3.4], ['legal', 3.4, 3.9],
  ].map(([text, start, end]) => ({ text, start, end })),
});

const storyboard = {
  title: 'Demo', cast: [{ id: 'ken', bodyColor: '#ff7a1a', role: 'host' }, { id: 'mio', bodyColor: '#7a4dff', glasses: true, role: 'skeptic' }],
  sets: [{ id: 'street', brief: 'neon street' }, { id: 'hall', brief: 'pachinko hall' }],
  shots: [
    { id: 'shot_01', set: 'street', startWord: { word: 'Japan' }, summary: 'ken points at the sign', actors: ['ken', 'mio'], transition: 'cut' },
    { id: 'shot_02', set: 'hall', startWord: { word: 'But' }, summary: 'mio is shocked', actors: ['mio'], transition: 'dissolve' },
  ],
};
const setJson = (id: string) => ({
  id, lighting: 'cinema', background: '#0b1030', fog: { color: '#0b1030', near: 10, far: 34 },
  objects: [
    { kind: 'floor', id: 'road', size: [40, 60], color: '#14162b' },
    ...Array.from({ length: 8 }, (_, i) => ({ kind: 'box', id: `b${i}`, position: [-6 + i * 1.7, 3, -6], size: [1.5, 6, 2], color: '#1b2150', windows: true })),
    { kind: 'sign', id: 'sign', position: [0, 3.3, -3.9], size: [5, 1.2], text: 'パチンコ', color: '#ff3df0' },
    { kind: 'light', id: 'pink', position: [0, 4, -2], color: '#ff3df0' },
  ],
});
const goodCam = { position: [0, 1.8, 10], target: [0, 1.6, 0], fov: 40 };
const shotJson = (id: string, set: string, actors: string[], cam: object, events: object[]) => ({
  id, set, start: { word: 'x' }, camera: cam,
  actors: actors.map((a, i) => ({ id: a, bodyColor: a === 'ken' ? '#ff7a1a' : '#7a4dff', glasses: a === 'mio', position: [(i - (actors.length - 1) / 2) * 1.6, 0, 0] })),
  events,
});

function studioResponder(shot1Cam: (n: number) => object) {
  let shot1Calls = 0;
  return (req: CompletionRequest): string => {
    const sys = req.system;
    if (sys.includes('Director')) return '```json\n' + JSON.stringify(storyboard) + '\n```';
    if (sys.includes('Set Designer')) return JSON.stringify(setJson(/Set id: (\w+)/.exec(req.messages[0]!.content)![1]!));
    const plan = /"id":"(shot_\d\d)"/.exec(req.messages[0]!.content)![1]!;
    if (plan === 'shot_01') {
      shot1Calls++;
      return JSON.stringify(shotJson('shot_01', 'street', ['ken', 'mio'], shot1Cam(shot1Calls), [
        { type: 'gesture', actor: 'ken', at: { word: 'gambling' }, gesture: 'point' },
        { type: 'expression', actor: 'mio', at: { word: 'bans' }, expression: 'panic' },
      ]));
    }
    return JSON.stringify(shotJson('shot_02', 'hall', ['mio'], goodCam, [{ type: 'expression', actor: 'mio', at: { word: 'prize' }, expression: 'panic' }]));
  };
}

describe('produceProject', () => {
  it('builds a valid project from a script and writes it to disk', async () => {
    const p = new Scripted(studioResponder(() => goodCam));
    const out = mkdtempSync(join(tmpdir(), 'proj-'));
    const r = await produceProject({ provider: p, script: 'Japan bans gambling...', alignment, outDir: out, concurrency: 2 });
    expect(r.bundle.project.shots).toEqual(['shot_01', 'shot_02']);
    expect(r.bundle.shots.shot_01!.start).toBe(0);
    expect(r.bundle.shots.shot_02!.start).toBeCloseTo(1.7, 9);
    expect(r.bundle.shots.shot_02!.transitionIn.type).toBe('dissolve');
    expect(r.bundle.shots.shot_01!.events[0]!.at).toBeCloseTo(0.9, 9); // anchor resolved to "gambling"
    for (const f of ['project.json', 'sets/street.json', 'sets/hall.json', 'shots/shot_01.json', 'shots/shot_02.json', 'audio/alignment.json']) {
      expect(existsSync(join(out, f)), f).toBe(true);
    }
    // on-disk shots keep anchors (not seconds) and no hard-coded duration
    const disk = JSON.parse(readFileSync(join(out, 'shots/shot_02.json'), 'utf8'));
    expect(disk.start).toEqual({ word: 'But', nth: 1, edge: 'start', offset: 0 });
    expect(disk.duration).toBeUndefined();
  });

  it('sends a head-cropping camera back with the framing problem and accepts the repair', async () => {
    const cropped = { position: [0, 1.8, 10], target: [0, 1.6, 0], fov: 40 };
    const p = new Scripted(studioResponder((n) => (n === 1 ? { ...cropped, position: [0, 1.8, 3.2] } : goodCam)));
    const r = await produceProject({ provider: p, script: 's', alignment });
    expect(r.shots[0]!.camera.position).toEqual([0, 1.8, 10]);
    const repair = p.calls.find((c) => c.messages.length === 3 && c.system.includes('Scene Builder') && c.messages[0]!.content.includes('shot_01'))!;
    expect(repair.messages.at(-1)!.content).toMatch(/eyes leave the frame/);
  });

  it('rejects a storyboard that anchors a word the voiceover never says', async () => {
    const bad = { ...storyboard, shots: [{ ...storyboard.shots[0]!, startWord: { word: 'pachinko' } }, storyboard.shots[1]!] };
    const p = new Scripted((req) => (req.system.includes('Director') ? JSON.stringify(bad) : ''));
    await expect(produceProject({ provider: p, script: 's', alignment })).rejects.toThrow(/"pachinko" not found/);
  });
});

describe('Scene Builder and props', () => {
  const propShot = (props: object[], propEvents: object[]) => ({
    ...shotJson('shot_01', 'street', ['ken', 'mio'], goodCam, []),
    props,
    propEvents,
  });
  const counter = { kind: 'counter', id: 'yen', position: [0, 4, 0], digits: 2, scale: 0.8 };

  const run = (responses: (n: number) => object) => {
    let n = 0;
    const base = studioResponder(() => goodCam);
    return new Scripted((req) => {
      if (req.system.includes('Scene Builder') && req.messages[0]!.content.includes('shot_01')) return JSON.stringify(responses(++n));
      return base(req);
    });
  };

  it('keeps a valid counter and anchors its event to a word in the shot', async () => {
    const p = run(() => propShot([counter], [{ prop: 'yen', at: { word: 'gambling' }, value: 34 }]));
    const r = await produceProject({ provider: p, script: 's', alignment });
    expect(r.bundle.shots.shot_01!.props).toHaveLength(1);
    expect(r.bundle.shots.shot_01!.propEvents[0]!.at).toBeCloseTo(0.9, 9);
  });

  it('sends back a prop event with the wrong payload, an unknown prop, or an anchor outside the shot', async () => {
    const bad = propShot(
      [{ kind: 'clock', id: 'clk', position: [0, 4, 0] }],
      [{ prop: 'clk', at: { word: 'gambling' }, value: 3 }, { prop: 'ghost', at: { word: 'gambling' }, value: 1 }, { prop: 'clk', at: { word: 'legal' }, time: '3:00' }],
    );
    const good = propShot([{ kind: 'clock', id: 'clk', position: [0, 4, 0] }], [{ prop: 'clk', at: { word: 'gambling' }, time: '3:00' }]);
    const p = run((n) => (n === 1 ? bad : good));
    await produceProject({ provider: p, script: 's', alignment });
    const repair = p.calls.find((c) => c.system.includes('Scene Builder') && c.messages.length === 3)!.messages.at(-1)!.content;
    expect(repair).toMatch(/needs "time"/);
    expect(repair).toMatch(/unknown prop "ghost"/);
    expect(repair).toMatch(/outside this shot/);
  });

  it('sends back a prop that does not fit the frame', async () => {
    const wide = propShot([{ kind: 'counter', id: 'yen', position: [0, 4, 0], digits: 6, prefix: '¥', suffix: 'B' }], []);
    const p = run((n) => (n === 1 ? wide : propShot([counter], [])));
    await produceProject({ provider: p, script: 's', alignment });
    expect(p.calls.find((c) => c.system.includes('Scene Builder') && c.messages.length === 3)!.messages.at(-1)!.content).toMatch(/counter "yen" is cut off/);
  });

  it('documents props in the Scene Builder prompt', () => {
    expect(SHOT_SYSTEM).toMatch(/counter/);
    expect(SHOT_SYSTEM).toMatch(/propEvents/);
  });
});
