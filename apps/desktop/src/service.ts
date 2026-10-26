import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { editShot, type LlmProvider } from '@shortstudio/agents';
import { runQualityGate } from '@shortstudio/qa';
import { Alignment, ShotSource, parseBundle, projectDuration, type Bundle } from '@shortstudio/schema';
import { finishExport } from '../../render/finishExport';
import { loadProject, readRaw } from '../../render/project';
import type { Applied, EditRequest, ExportResult, HistoryEntry, OpenedProject, Proposal, ServiceApi, Settings, SettingsView } from './api';
import { DEFAULT_SETTINGS } from './provider';
import { diffJson } from './diff';

interface Stored {
  proposal: Proposal;
  before: string;
  after: string;
}

interface Entry {
  n: number;
  shotId: string;
  target: EditRequest['target'];
  instruction: string;
  at: string;
  before: string;
  after: string;
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

/**
 * Everything click-to-edit needs that is not drawing: open a project, turn "this thing + this instruction" into a
 * proposed rewrite of ONE shot file, show it as a diff, apply it by overwriting only that file, and undo or redo.
 * No Electron in here, so it is tested directly and served over IPC or HTTP by thin transports.
 */
export class ProjectService implements ServiceApi {
  private dir: string | undefined;
  private proposals = new Map<string, Stored>();
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private counter = 0;

  private settings: Settings = { ...DEFAULT_SETTINGS };
  private apiKey: string | undefined;
  private exports = new Map<string, { dir: string; file: string }>();

  constructor(
    private opts: {
      provider: () => LlmProvider;
      /** Called when settings change so the host can persist them (the key goes to an encrypted store, not a file). */
      onSettings?: (s: Settings, apiKey: string | undefined) => void;
      ffmpeg?: string;
    },
  ) {}

  /** Used by the host at start-up to restore saved settings. */
  restoreSettings(s: Partial<Settings>, apiKey?: string): void {
    this.settings = { ...this.settings, ...s };
    this.apiKey = apiKey;
  }

  get currentSettings(): { settings: Settings; apiKey: string | undefined } {
    return { settings: this.settings, apiKey: this.apiKey };
  }

  async getSettings(): Promise<SettingsView> {
    return { ...this.settings, hasApiKey: Boolean(this.apiKey || process.env.ANTHROPIC_API_KEY) };
  }

  async saveSettings(s: Partial<Settings> & { apiKey?: string }): Promise<SettingsView> {
    const { apiKey, ...rest } = s;
    this.settings = { ...this.settings, ...rest };
    if (apiKey !== undefined) this.apiKey = apiKey || undefined;
    this.opts.onSettings?.(this.settings, this.apiKey);
    return this.getSettings();
  }

  async defaultExportPath(): Promise<string> {
    const dir = this.need();
    const out = join(dir, 'out');
    mkdirSync(out, { recursive: true });
    return join(out, `${resolve(dir).split(/[\\/]/).pop()}.mp4`);
  }

  async exportStart(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'shortstudio-export-'));
    const id = `x${++this.counter}`;
    const file = join(dir, 'video.mp4');
    writeFileSync(file, '');
    this.exports.set(id, { dir, file });
    return id;
  }

  async exportChunk(id: string, base64: string): Promise<void> {
    const x = this.exports.get(id);
    if (!x) throw new Error(`no export "${id}" in progress`);
    appendFileSync(x.file, Buffer.from(base64, 'base64'));
  }

  async exportFinish(id: string, o: { mux: string; outPath: string }): Promise<ExportResult> {
    const x = this.exports.get(id);
    if (!x) throw new Error(`no export "${id}" in progress`);
    try {
      const dir = this.need();
      const { bundle, voiceover } = loadProject(dir);
      mkdirSync(resolve(o.outPath, '..'), { recursive: true });
      const done = finishExport({ projectDir: dir, bundle, voiceover, videoPath: x.file, mux: o.mux, outPath: o.outPath, ffmpeg: this.opts.ffmpeg });
      return { outPath: o.outPath, lines: done.lines };
    } finally {
      rmSync(x.dir, { recursive: true, force: true });
      this.exports.delete(id);
    }
  }

  private need(): string {
    if (!this.dir) throw new Error('no project is open');
    return this.dir;
  }

  /** shot id -> the file that defines it. Rebuilt on demand so edits made outside the app are respected. */
  private shotFiles(): Map<string, string> {
    const dir = join(this.need(), 'shots');
    const map = new Map<string, string>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      const path = join(dir, f);
      map.set(JSON.parse(readFileSync(path, 'utf8')).id, path);
    }
    return map;
  }

  async open(dir: string): Promise<OpenedProject> {
    const abs = resolve(dir);
    const { bundle } = loadProject(abs); // throws a readable BundleError if the project is invalid
    this.dir = abs;
    this.proposals.clear();
    this.undoStack = [];
    this.redoStack = [];
    return {
      dir: abs,
      name: bundle.project.name,
      bundle,
      duration: projectDuration(bundle),
      hasAlignment: Boolean(bundle.alignment),
      issues: runQualityGate(bundle).issues,
    };
  }

  async proposeEdit(req: EditRequest): Promise<Proposal> {
    const dir = this.need();
    const files = this.shotFiles();
    const file = files.get(req.shotId);
    if (!file) throw new Error(`unknown shot "${req.shotId}"; the shots are: ${[...files.keys()].join(', ')}`);
    if (!req.instruction.trim()) throw new Error('say what to change');

    const current = loadProject(dir).bundle;
    const resolved = current.shots[req.shotId]!;
    const raw = readRaw(dir);
    const before = ShotSource.parse(JSON.parse(readFileSync(file, 'utf8')));
    const alignment = current.alignment ?? Alignment.parse({ words: [] });

    const after = await editShot(this.opts.provider(), {
      shot: before,
      sets: current.sets,
      alignment,
      start: resolved.start,
      end: resolved.start + resolved.duration,
      target: req.target,
      instruction: req.instruction,
      allowSeconds: !current.alignment,
    });

    // the whole project, with only this shot replaced: if this is invalid anywhere, the edit is refused before the preview
    const candidate = parseBundle(
      { project: raw.project, sets: raw.sets, shots: raw.shots.map((s) => ((s as { id: string }).id === req.shotId ? after : s)) },
      { alignment: current.alignment },
    );
    const issues = runQualityGate(candidate).issues.filter((i) => i.shot === req.shotId);

    const proposal: Proposal = {
      id: `p${++this.counter}`,
      shotId: req.shotId,
      target: req.target,
      instruction: req.instruction,
      diff: diffJson(before, after),
      bundle: candidate,
      changed: [req.shotId],
      issues,
    };
    this.proposals.set(proposal.id, { proposal, before: pretty(before), after: pretty(after) });
    return proposal;
  }

  async acceptEdit(id: string): Promise<Applied> {
    const dir = this.need();
    const stored = this.proposals.get(id);
    if (!stored) throw new Error(`no pending edit "${id}" (it was already applied or rejected)`);
    const { proposal } = stored;
    const file = this.shotFiles().get(proposal.shotId)!;

    // snapshot the file exactly as it is, then overwrite just this one file
    const original = readFileSync(file, 'utf8');
    const histDir = join(dir, '.shortstudio', 'history', proposal.shotId);
    mkdirSync(histDir, { recursive: true });
    const n = readdirSync(histDir).length + 1;
    writeFileSync(join(histDir, `${String(n).padStart(4, '0')}-before.json`), original);
    writeFileSync(file, stored.after);

    this.undoStack.push({ n: ++this.counter, shotId: proposal.shotId, target: proposal.target, instruction: proposal.instruction, at: new Date().toISOString(), before: original, after: stored.after });
    this.redoStack = [];
    this.proposals.delete(id);
    return this.applied(proposal.shotId);
  }

  async rejectEdit(id: string): Promise<void> {
    this.proposals.delete(id);
  }

  async undo(): Promise<Applied | null> {
    const e = this.undoStack.pop();
    if (!e) return null;
    writeFileSync(this.shotFiles().get(e.shotId)!, e.before);
    this.redoStack.push(e);
    return this.applied(e.shotId);
  }

  async redo(): Promise<Applied | null> {
    const e = this.redoStack.pop();
    if (!e) return null;
    writeFileSync(this.shotFiles().get(e.shotId)!, e.after);
    this.undoStack.push(e);
    return this.applied(e.shotId);
  }

  async history(): Promise<HistoryEntry[]> {
    return this.historyList();
  }

  private historyList(): HistoryEntry[] {
    const entry = (e: Entry, state: HistoryEntry['state']): HistoryEntry => ({ n: e.n, shotId: e.shotId, target: e.target, instruction: e.instruction, at: e.at, state });
    return [...this.undoStack.map((e) => entry(e, 'applied')), ...[...this.redoStack].reverse().map((e) => entry(e, 'undone'))];
  }

  private applied(shotId: string): Applied {
    const bundle: Bundle = loadProject(this.need()).bundle; // from disk: what is shown is what is saved
    return { bundle, changed: [shotId], history: this.historyList() };
  }
}

