import { Studio } from '@shortstudio/engine';
import { exportVideo } from '@shortstudio/export';
import type { Bundle } from '@shortstudio/schema';
import type { Applied, HistoryEntry, OpenedProject, Proposal, SettingsView, Target } from '../src/api';
import { host, messageOf, service } from './bridge';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const PREVIEW_WIDTH = 540;
const KIND_NAME = { actor: 'character', prop: 'prop', set: 'set object' } as const;

interface State {
  project?: OpenedProject;
  /** What the viewport shows (may include an unsaved proposal). */
  bundle?: Bundle;
  /** What is saved on disk; a discarded proposal goes back to this. */
  committed?: Bundle;
  history: HistoryEntry[];
  studio?: Studio;
  t: number;
  playing: boolean;
  selected?: Target & { shotId: string };
  proposal?: Proposal;
  busy: boolean;
}
const state: State = { t: 0, playing: false, busy: false, history: [] };

// ------------------------------------------------------------------ helpers

function status(msg: string, error = false) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('error', error);
}

function setBusy(text: string | null) {
  state.busy = text !== null;
  $('busy').hidden = text === null;
  $('busy-text').textContent = text ?? '';
  refreshButtons();
  if (state.busy) for (const id of ['play', 'export']) ($(id) as HTMLButtonElement).disabled = true;
}

const fmt = (s: number) => s.toFixed(2);

function render() {
  const { studio, bundle } = state;
  if (!studio || !bundle) return;
  studio.renderAt(state.t);
  const duration = studio.duration;
  ($('timeline') as HTMLInputElement).value = String(state.t);
  $('time').textContent = `${fmt(state.t)} / ${fmt(duration)} s`;
}

function drawTicks() {
  const { bundle, studio } = state;
  const ticks = $('ticks');
  ticks.replaceChildren();
  if (!bundle || !studio) return;
  for (const id of bundle.project.shots) {
    const s = bundle.shots[id]!;
    const i = document.createElement('i');
    i.style.left = `${(s.start / studio.duration) * 100}%`;
    i.title = s.id;
    ticks.append(i);
  }
}

function loadBundle(bundle: Bundle, changed?: string[]) {
  state.bundle = bundle;
  if (!state.studio) return;
  state.studio.updateBundle(bundle, changed);
  if (state.selected) state.studio.highlight(state.selected); // the rebuilt scene needs its selection box back
  drawTicks();
  render();
}

function refreshButtons() {
  const open = Boolean(state.project);
  for (const id of ['play', 'export']) ($(id) as HTMLButtonElement).disabled = !open;
  ($('timeline') as HTMLInputElement).disabled = !open;
  ($('undo') as HTMLButtonElement).disabled = state.busy || Boolean(state.proposal) || !state.history.some((h) => h.state === 'applied');
  ($('redo') as HTMLButtonElement).disabled = state.busy || Boolean(state.proposal) || !state.history.some((h) => h.state === 'undone');
  ($('submit') as HTMLButtonElement).disabled = state.busy;
  ($('apply') as HTMLButtonElement).disabled = state.busy;
  ($('discard') as HTMLButtonElement).disabled = state.busy;
  ($('open') as HTMLButtonElement).disabled = state.busy;
}

// ------------------------------------------------------------------- history

function showHistory(history: HistoryEntry[]) {
  const ol = $('history');
  ol.replaceChildren();
  if (!history.length) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = 'No edits yet.';
    ol.append(li);
  }
  for (const h of history) {
    const li = document.createElement('li');
    li.className = h.state;
    li.textContent = `${h.shotId} → ${h.target.kind} “${h.target.id}”: ${h.instruction}`;
    ol.append(li);
  }
  state.history = history;
  refreshButtons();
}

// ------------------------------------------------------------------ project

async function openProject(dir: string) {
  setBusy('Opening…');
  try {
    const p = await service.open(dir);
    state.project = p;
    state.selected = undefined;
    state.proposal = undefined;
    state.t = 0;
    state.playing = false;
    $('play').textContent = '▶';
    $('project-name').textContent = p.name;
    const bundle = p.bundle;
    const w = PREVIEW_WIDTH;
    const h = Math.round((PREVIEW_WIDTH * bundle.project.height) / bundle.project.width / 2) * 2;
    if (!state.studio) state.studio = new Studio($('stage') as HTMLCanvasElement, w, h);
    state.studio.load(bundle);
    state.bundle = state.committed = bundle;
    $('stage-wrap').classList.add('loaded');
    ($('timeline') as HTMLInputElement).max = String(state.studio.duration);
    $('edit-panel').hidden = true;
    $('proposal').hidden = true;
    showHistory([]);
    drawTicks();
    render();
    const errs = p.issues.filter((i) => i.severity === 'error').length;
    status(errs ? `${errs} quality-gate error(s) in this project; see Export.` : 'Click anything in the picture to edit it.');
  } catch (e) {
    status(messageOf(e), true);
  } finally {
    setBusy(null);
  }
}

// -------------------------------------------------------------- selection/edit

function clearSelection() {
  if (state.proposal) return; // finish the pending edit first
  state.selected = undefined;
  state.studio?.highlight(null);
  $('edit-panel').hidden = true;
  render();
}

function onCanvasClick(ev: MouseEvent) {
  const { studio } = state;
  if (!studio || state.busy) return;
  if (state.proposal) return status('Apply or discard the proposed change first.');
  const r = $('stage').getBoundingClientRect();
  const x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  const y = -(((ev.clientY - r.top) / r.height) * 2 - 1);
  const hit = studio.pick(state.t, x, y);
  if (!hit) return clearSelection();
  state.selected = { shotId: hit.shotId, kind: hit.kind, id: hit.id };
  studio.highlight(state.selected);
  $('target-label').textContent = `Edit ${hit.shotId} → ${KIND_NAME[hit.kind]} “${hit.id}”`;
  $('edit-panel').hidden = false;
  ($('prompt') as HTMLTextAreaElement).focus();
  status('');
  render();
}

function showProposal(p: Proposal) {
  $('proposal-meta').textContent = `${p.diff.filter((l) => l.op !== ' ').length} lines changed`;
  const diff = $('diff');
  diff.replaceChildren();
  for (const l of p.diff) {
    const span = document.createElement('span');
    span.className = l.op === '+' ? 'add' : l.op === '-' ? 'del' : 'ctx';
    span.textContent = `${l.op} ${l.text}`;
    diff.append(span);
  }
  const issues = $('issues');
  issues.replaceChildren();
  for (const i of p.issues) {
    const li = document.createElement('li');
    li.className = i.severity;
    li.textContent = `${i.severity === 'error' ? 'Problem' : 'Note'}: ${i.message}`;
    issues.append(li);
  }
  $('proposal').hidden = false;
  $('edit-panel').hidden = true;
  refreshButtons();
}

async function submitEdit() {
  const sel = state.selected;
  const instruction = ($('prompt') as HTMLTextAreaElement).value.trim();
  if (!sel || state.busy) return;
  if (!instruction) return status('Say what to change first.', true);
  const started = Date.now();
  const timer = setInterval(() => ($('busy-text').textContent = `Editing ${sel.shotId}… ${Math.round((Date.now() - started) / 1000)}s`), 500);
  setBusy(`Editing ${sel.shotId}… 0s`);
  try {
    const p = await service.proposeEdit({ shotId: sel.shotId, target: { kind: sel.kind, id: sel.id }, instruction });
    state.proposal = p;
    loadBundle(p.bundle, p.changed); // instant preview of just this shot; nothing is saved yet
    showProposal(p);
    status('Review the change. Nothing is saved until you press Apply.');
  } catch (e) {
    status(messageOf(e), true);
  } finally {
    clearInterval(timer);
    setBusy(null);
  }
}

async function afterApplied(a: Applied | null, what: string) {
  if (!a) return status(`Nothing to ${what}.`);
  state.committed = a.bundle;
  loadBundle(a.bundle, a.changed);
  showHistory(a.history);
  status(`${what[0]!.toUpperCase()}${what.slice(1)} done (${a.changed.join(', ')}).`);
}

async function apply() {
  const p = state.proposal;
  if (!p || state.busy) return;
  setBusy('Saving…');
  try {
    const a = await service.acceptEdit(p.id);
    state.proposal = undefined;
    $('proposal').hidden = true;
    ($('prompt') as HTMLTextAreaElement).value = '';
    $('edit-panel').hidden = !state.selected;
    await afterApplied(a, 'apply');
    refreshButtons();
    status(`Applied. Only shots/${p.shotId}.json changed.`);
  } catch (e) {
    status(messageOf(e), true);
  } finally {
    setBusy(null);
  }
}

async function discard() {
  const p = state.proposal;
  if (!p || state.busy) return;
  await service.rejectEdit(p.id);
  state.proposal = undefined;
  $('proposal').hidden = true;
  $('edit-panel').hidden = !state.selected;
  loadBundle(state.committed!, p.changed); // back to what is saved
  refreshButtons();
  status('Discarded.');
}

async function undoRedo(kind: 'undo' | 'redo') {
  if (state.busy || state.proposal) return;
  setBusy(kind === 'undo' ? 'Undoing…' : 'Redoing…');
  try {
    await afterApplied(await service[kind](), kind);
  } catch (e) {
    status(messageOf(e), true);
  } finally {
    setBusy(null);
  }
}

// -------------------------------------------------------------------- export

async function runExport() {
  const { bundle } = state;
  if (!bundle || state.busy) return;
  try {
    const def = await service.defaultExportPath();
    const out = host.pickExportPath ? await host.pickExportPath(def) : def;
    if (!out) return;
    setBusy('Exporting… 0%');
    // a separate engine at the project's full size: the preview stays 540px and the export is never marked by the selection box
    const canvas = document.createElement('canvas');
    const { width, height, fps } = bundle.project;
    const full = new Studio(canvas, width, height);
    full.load(bundle);
    let video;
    try {
      video = await exportVideo({
        width, height, fps, canvas, frames: Math.round(full.duration * fps),
        renderFrame: (f) => full.renderAt(f / fps),
        onProgress: (d, t) => ($('busy-text').textContent = `Exporting… ${Math.round((d / t) * 100)}%`),
      });
    } finally {
      full.renderer.dispose();
      full.renderer.forceContextLoss();
    }
    $('busy-text').textContent = 'Mixing audio and saving…';
    const id = await service.exportStart();
    const CHUNK = 3 * 1024 * 1024;
    for (let o = 0; o < video.bytes.length; o += CHUNK) {
      let bin = '';
      const part = video.bytes.subarray(o, o + CHUNK);
      for (let i = 0; i < part.length; i += 0x8000) bin += String.fromCharCode(...part.subarray(i, i + 0x8000));
      await service.exportChunk(id, btoa(bin));
    }
    const r = await service.exportFinish(id, { mux: video.mux, outPath: out });
    status(`Exported ${r.outPath}. ${r.lines.find((l) => l.startsWith('master')) ?? ''}`);
  } catch (e) {
    status(messageOf(e), true);
  } finally {
    setBusy(null);
  }
}

// ------------------------------------------------------------------ settings

async function openSettings() {
  const s: SettingsView = await service.getSettings();
  ($('s-provider') as HTMLSelectElement).value = s.provider;
  ($('s-cli') as HTMLInputElement).value = s.cliCommand;
  ($('s-cli-args') as HTMLInputElement).value = s.cliArgs;
  ($('s-model') as HTMLInputElement).value = s.model;
  ($('s-key') as HTMLInputElement).value = '';
  $('s-key-state').textContent = s.hasApiKey ? 'An API key is available.' : 'No API key set; the Claude API backend will use ANTHROPIC_API_KEY if present.';
  ($('settings-dialog') as HTMLDialogElement).showModal();
}

async function saveSettings(ev: Event) {
  const submitter = (ev as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value !== 'save') return;
  const key = ($('s-key') as HTMLInputElement).value;
  await service.saveSettings({
    provider: ($('s-provider') as HTMLSelectElement).value as 'api' | 'cli',
    cliCommand: ($('s-cli') as HTMLInputElement).value || 'claude',
    cliArgs: ($('s-cli-args') as HTMLInputElement).value,
    model: ($('s-model') as HTMLInputElement).value || 'claude-opus-5-5',
    ...(key ? { apiKey: key } : {}),
  });
  status('Settings saved.');
}

// ------------------------------------------------------------------ playback

let last = 0;
function tick(now: number) {
  if (!state.playing || !state.studio) return;
  state.t += (now - last) / 1000;
  last = now;
  if (state.t >= state.studio.duration) state.t = 0;
  render();
  requestAnimationFrame(tick);
}

function togglePlay() {
  if (!state.studio) return;
  state.playing = !state.playing;
  $('play').textContent = state.playing ? '❚❚' : '▶';
  if (state.playing) {
    last = performance.now();
    requestAnimationFrame(tick);
  }
}

// -------------------------------------------------------------------- wiring

$('open').addEventListener('click', async () => {
  const dir = host.pickProjectDir ? await host.pickProjectDir() : prompt('Project folder:');
  if (dir) await openProject(dir);
});
$('stage').addEventListener('click', onCanvasClick);
$('submit').addEventListener('click', submitEdit);
$('clear').addEventListener('click', clearSelection);
$('apply').addEventListener('click', apply);
$('discard').addEventListener('click', discard);
$('undo').addEventListener('click', () => undoRedo('undo'));
$('redo').addEventListener('click', () => undoRedo('redo'));
$('export').addEventListener('click', runExport);
$('play').addEventListener('click', togglePlay);
$('settings').addEventListener('click', openSettings);
$('settings-dialog').addEventListener('close', () => {});
($('settings-dialog').querySelector('form') as HTMLFormElement).addEventListener('submit', saveSettings);
$('timeline').addEventListener('input', (e) => {
  state.playing = false;
  $('play').textContent = '▶';
  state.t = Number((e.target as HTMLInputElement).value);
  render();
});
$('prompt').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submitEdit();
});
window.addEventListener('keydown', (e) => {
  const typing = (e.target as HTMLElement).matches('textarea, input, select');
  if (e.key === 'Escape' && !typing) clearSelection();
  else if (e.key === ' ' && !typing) { e.preventDefault(); togglePlay(); }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undoRedo(e.shiftKey ? 'redo' : 'undo'); }
});

// debug/test hooks: the page is otherwise only reachable through the DOM
(window as unknown as { __app: unknown }).__app = {
  state,
  seek: (t: number) => { state.playing = false; state.t = t; render(); },
  open: openProject,
};

// the harness opens a project named in the URL (?project=...); Electron opens one through the Open button
const preset = new URLSearchParams(location.search).get('project');
if (preset) void openProject(preset);
