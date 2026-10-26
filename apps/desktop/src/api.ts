import type { Bundle } from '@shortstudio/schema';
import type { Issue } from '@shortstudio/qa';
import type { DiffLine } from './diff';

/** What can be clicked in a rendered shot. */
export interface Target {
  kind: 'actor' | 'prop' | 'set';
  id: string;
}

export interface OpenedProject {
  dir: string;
  name: string;
  bundle: Bundle;
  duration: number;
  /** False means times are plain seconds; edits are checked accordingly. */
  hasAlignment: boolean;
  issues: Issue[];
}

export interface EditRequest {
  shotId: string;
  target: Target;
  instruction: string;
}

export interface Proposal {
  id: string;
  shotId: string;
  target: Target;
  instruction: string;
  /** Added/removed lines of the shot JSON. */
  diff: DiffLine[];
  /** The whole project with the edit applied in memory, for an instant preview (nothing is on disk yet). */
  bundle: Bundle;
  changed: string[];
  /** Quality-gate findings for the edited shot (warnings are shown; errors mean the agent could not fully repair it). */
  issues: Issue[];
}

export interface HistoryEntry {
  n: number;
  shotId: string;
  target: Target;
  instruction: string;
  at: string;
  state: 'applied' | 'undone';
}

export interface Applied {
  bundle: Bundle;
  changed: string[];
  history: HistoryEntry[];
}

/** Which model rewrites shots. The API key is held by the main process and never sent back to the page. */
export interface Settings {
  provider: 'api' | 'cli';
  /** Claude API model (default claude-opus-5-5). */
  model: string;
  /** Local CLI for the cli provider, e.g. "claude" or "gemini". */
  cliCommand: string;
  cliArgs: string;
}

export interface SettingsView extends Settings {
  /** An API key is stored (or ANTHROPIC_API_KEY is set); the key itself is never returned. */
  hasApiKey: boolean;
}

export interface ExportResult {
  outPath: string;
  /** Plain-language mix summary: levels, effect count, master loudness. */
  lines: string[];
}

/** One call surface, two transports: Electron IPC in the app, HTTP in the browser harness. */
export interface ServiceApi {
  open(dir: string): Promise<OpenedProject>;
  proposeEdit(req: EditRequest): Promise<Proposal>;
  acceptEdit(id: string): Promise<Applied>;
  rejectEdit(id: string): Promise<void>;
  undo(): Promise<Applied | null>;
  redo(): Promise<Applied | null>;
  history(): Promise<HistoryEntry[]>;
  getSettings(): Promise<SettingsView>;
  saveSettings(s: Partial<Settings> & { apiKey?: string }): Promise<SettingsView>;
  /** Where an export goes by default: <project>/out/<name>.mp4. */
  defaultExportPath(): Promise<string>;
  /** The page encodes video (WebCodecs) and streams it here in chunks; the service mixes audio and attaches it. */
  exportStart(): Promise<string>;
  exportChunk(id: string, base64: string): Promise<void>;
  exportFinish(id: string, opts: { mux: string; outPath: string }): Promise<ExportResult>;
}
