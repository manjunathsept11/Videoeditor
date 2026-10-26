import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CompletionRequest, LlmProvider } from '@shortstudio/agents';
import { ProjectService } from '../src/service';
import { changedLines, diffJson, diffLines } from '../src/diff';

const root = resolve(__dirname, '../../..');

class Scripted implements LlmProvider {
  readonly name = 'scripted';
  calls: CompletionRequest[] = [];
  constructor(private respond: (req: CompletionRequest, n: number) => unknown) {}
  async complete(req: CompletionRequest) {
    this.calls.push(structuredClone(req));
    return JSON.stringify(this.respond(req, this.calls.length));
  }
}

/** A throwaway copy of an example project. */
const copyProject = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `svc-${name}-`));
  cpSync(resolve(root, 'examples', name), dir, { recursive: true });
  return dir;
};

/** path -> file text for every file under dir (history snapshots excluded). */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (f === '.shortstudio') continue;
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

/** The JSON the editor would send back: read the shot from the prompt and change a prefix. */
const editPrefix = (prefix: string) => (req: CompletionRequest) => {
  const user = req.messages[0]!.content;
  const shot = JSON.parse(/Current shot JSON:\n([\s\S]*?)\n\nObjects in/.exec(user)![1]!);
  shot.props = shot.props.map((p: { kind: string }) => (p.kind === 'counter' ? { ...p, prefix } : p));
  return shot;
};

describe('diffLines', () => {
  it('marks added and removed lines and collapses unchanged stretches', () => {
    const a = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n');
    const b = ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h', 'i', 'j'].join('\n');
    const d = diffLines(a, b, 1);
    expect(d.filter((l) => l.op !== ' ')).toEqual([{ op: '-', text: 'e' }, { op: '+', text: 'E' }]);
    expect(d.map((l) => l.text)).toEqual(['…', 'd', 'e', 'E', 'f', '…']);
  });
  it('is empty of changes for identical text, and handles pure additions and removals', () => {
    expect(changedLines(diffLines('x\ny', 'x\ny'))).toBe(0);
    expect(diffLines('x', 'x\ny').filter((l) => l.op === '+').map((l) => l.text)).toEqual(['y']);
    expect(diffLines('x\ny', 'x').filter((l) => l.op === '-').map((l) => l.text)).toEqual(['y']);
  });
  it('diffs JSON structurally by pretty-printing', () => {
    const d = diffJson({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } });
    expect(d.filter((l) => l.op === '+').map((l) => l.text.trim())).toEqual(['"c": 3']);
  });
});

describe('ProjectService: open', () => {
  it('opens a project and reports its bundle, length and quality-gate findings', async () => {
    const svc = new ProjectService({ provider: () => new Scripted(() => ({})) });
    const p = await svc.open(copyProject('props'));
    expect(p.name).toBe('Props demo');
    expect(p.hasAlignment).toBe(true);
    expect(p.duration).toBeGreaterThan(7);
    expect(Object.keys(p.bundle.shots)).toHaveLength(5);
    expect(p.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
  it('says what is wrong with a project that will not load, and refuses to edit with nothing open', async () => {
    const svc = new ProjectService({ provider: () => new Scripted(() => ({})) });
    await expect(svc.proposeEdit({ shotId: 'shot_01', target: { kind: 'prop', id: 'yen' }, instruction: 'x' })).rejects.toThrow(/no project is open/);
    await expect(svc.open('/definitely/not/here')).rejects.toThrow();
  });
});

describe('ProjectService: propose, accept, undo, redo', () => {
  const setup = async () => {
    const dir = copyProject('props');
    const provider = new Scripted(editPrefix('$'));
    const svc = new ProjectService({ provider: () => provider });
    await svc.open(dir);
    return { dir, svc, provider };
  };
  const req = { shotId: 'shot_01', target: { kind: 'prop' as const, id: 'yen' }, instruction: 'make it dollars' };

  it('a proposal writes nothing to disk, but previews the edit and shows a diff', async () => {
    const { dir, svc } = await setup();
    const before = snapshot(dir);
    const p = await svc.proposeEdit(req);
    expect(snapshot(dir)).toEqual(before); // untouched
    expect(p.diff.filter((l) => l.op === '+').map((l) => l.text.trim())).toContain('"prefix": "$",');
    expect(p.diff.filter((l) => l.op === '-').map((l) => l.text.trim())).toContain('"prefix": "¥",');
    expect((p.bundle.shots.shot_01!.props[0] as { prefix: string }).prefix).toBe('$'); // instant preview
    expect(p.changed).toEqual(['shot_01']);
  });

  it('sends the agent only the clicked shot, not the rest of the project', async () => {
    const { svc, provider } = await setup();
    await svc.proposeEdit(req);
    const user = provider.calls[0]!.messages[0]!.content;
    expect(user).toContain('"id": "shot_01"');
    expect(user).not.toContain('shot_02');
    expect(user).not.toContain('"id": "shot_03"');
  });

  it('accepting rewrites exactly one shot file; every other file is byte-identical', async () => {
    const { dir, svc } = await setup();
    const before = snapshot(dir);
    const p = await svc.proposeEdit(req);
    const applied = await svc.acceptEdit(p.id);
    const after = snapshot(dir);
    const changed = Object.keys(after).filter((f) => after[f] !== before[f]);
    expect(changed).toEqual(['shots/shot_01.json']);
    expect(Object.keys(after)).toEqual(Object.keys(before)); // nothing added or removed outside .shortstudio
    expect(applied.changed).toEqual(['shot_01']);
    expect((applied.bundle.shots.shot_01!.props[0] as { prefix: string }).prefix).toBe('$');
    expect(applied.history).toHaveLength(1);
  });

  it('undo restores the original file exactly, and redo reapplies it', async () => {
    const { dir, svc } = await setup();
    const original = readFileSync(join(dir, 'shots/shot_01.json'), 'utf8');
    await svc.acceptEdit((await svc.proposeEdit(req)).id);
    const edited = readFileSync(join(dir, 'shots/shot_01.json'), 'utf8');
    expect(edited).not.toBe(original);

    const undone = await svc.undo();
    expect(readFileSync(join(dir, 'shots/shot_01.json'), 'utf8')).toBe(original); // byte for byte
    expect((undone!.bundle.shots.shot_01!.props[0] as { prefix: string }).prefix).toBe('¥');
    expect((await svc.history())[0]!.state).toBe('undone');

    await svc.redo();
    expect(readFileSync(join(dir, 'shots/shot_01.json'), 'utf8')).toBe(edited);
    expect((await svc.history())[0]!.state).toBe('applied');
    expect(await svc.redo()).toBeNull();
  });

  it('undo with nothing to undo is a no-op, and a new edit clears the redo stack', async () => {
    const { svc } = await setup();
    expect(await svc.undo()).toBeNull();
    await svc.acceptEdit((await svc.proposeEdit(req)).id);
    await svc.undo();
    await svc.acceptEdit((await svc.proposeEdit({ ...req, instruction: 'again' })).id);
    expect(await svc.redo()).toBeNull();
  });

  it('keeps a snapshot of each shot before every accepted edit', async () => {
    const { dir, svc } = await setup();
    const original = readFileSync(join(dir, 'shots/shot_01.json'), 'utf8');
    await svc.acceptEdit((await svc.proposeEdit(req)).id);
    expect(readFileSync(join(dir, '.shortstudio/history/shot_01/0001-before.json'), 'utf8')).toBe(original);
  });

  it('rejecting leaves everything alone, and an applied or rejected proposal cannot be accepted', async () => {
    const { dir, svc } = await setup();
    const before = snapshot(dir);
    const p = await svc.proposeEdit(req);
    await svc.rejectEdit(p.id);
    await expect(svc.acceptEdit(p.id)).rejects.toThrow(/no pending edit/);
    expect(snapshot(dir)).toEqual(before);
    const q = await svc.proposeEdit(req);
    await svc.acceptEdit(q.id);
    await expect(svc.acceptEdit(q.id)).rejects.toThrow(/already applied or rejected/);
  });

  it('refuses unknown shots and empty instructions before calling the model', async () => {
    const { svc, provider } = await setup();
    await expect(svc.proposeEdit({ ...req, shotId: '../../etc/passwd' })).rejects.toThrow(/unknown shot/);
    await expect(svc.proposeEdit({ ...req, instruction: '   ' })).rejects.toThrow(/say what to change/);
    expect(provider.calls).toHaveLength(0);
  });

  it('refuses an edit that would make the project invalid, and writes nothing', async () => {
    const dir = copyProject('props');
    const svc = new ProjectService({
      provider: () => new Scripted((req) => {
        const user = req.messages[0]!.content;
        const shot = JSON.parse(/Current shot JSON:\n([\s\S]*?)\n\nObjects in/.exec(user)![1]!);
        shot.propEvents = [{ prop: 'yen', at: { word: 'yen.' }, value: 5 }, { prop: 'ghost', at: { word: 'yen.' }, value: 1 }]; // never repairable
        return shot;
      }),
    });
    await svc.open(dir);
    const before = snapshot(dir);
    await expect(svc.proposeEdit({ shotId: 'shot_01', target: { kind: 'prop', id: 'yen' }, instruction: 'break it' })).rejects.toThrow(/unknown prop "ghost"/);
    expect(snapshot(dir)).toEqual(before);
  });

  it('an edit made outside the app between propose and accept is not silently lost from history', async () => {
    const { dir, svc } = await setup();
    const p = await svc.proposeEdit(req);
    const outside = readFileSync(join(dir, 'shots/shot_01.json'), 'utf8');
    await svc.acceptEdit(p.id);
    await svc.undo();
    expect(readFileSync(join(dir, 'shots/shot_01.json'), 'utf8')).toBe(outside); // undo restores what was there when we overwrote it
  });
});

describe('ProjectService: a project with no voiceover alignment', () => {
  it('lets the editor use plain seconds, as the project does', async () => {
    const dir = copyProject('rig');
    const seen: string[] = [];
    const svc = new ProjectService({
      provider: () => new Scripted((req) => {
        seen.push(req.messages[0]!.content);
        const shot = JSON.parse(/Current shot JSON:\n([\s\S]*?)\n\nObjects in/.exec(req.messages[0]!.content)![1]!);
        shot.events = shot.events.map((e: { type: string; at: number }) => (e.type === 'jolt' ? { ...e, at: 2.5 } : e));
        return shot;
      }),
    });
    const o = await svc.open(dir);
    expect(o.hasAlignment).toBe(false);
    const p = await svc.proposeEdit({ shotId: 'shot_01', target: { kind: 'actor', id: 'mio' }, instruction: 'jolt a bit later' });
    expect(seen[0]).toContain('no voiceover alignment');
    expect(p.diff.some((l) => l.op === '+' && l.text.includes('2.5'))).toBe(true);
  });
});
