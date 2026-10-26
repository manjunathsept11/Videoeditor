import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage } from 'electron';
import { ProjectService } from './service';
import { providerFromSettings } from './provider';
import type { Settings } from './api';

/** The service methods the page may call; anything else is refused. */
const METHODS = new Set(['open', 'proposeEdit', 'acceptEdit', 'rejectEdit', 'undo', 'redo', 'history', 'getSettings', 'saveSettings', 'defaultExportPath', 'exportStart', 'exportChunk', 'exportFinish']);

/** The ffmpeg that ships inside the installer (ffmpeg-static), unpacked from the asar archive. */
function bundledFfmpeg(): string | undefined {
  if (process.env.SHORTSTUDIO_FFMPEG) return process.env.SHORTSTUDIO_FFMPEG;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p: string | null = require('ffmpeg-static');
    return p ? p.replace('app.asar', 'app.asar.unpacked') : undefined;
  } catch {
    return undefined;
  }
}

const userData = () => app.getPath('userData');
const settingsFile = () => join(userData(), 'settings.json');
const keyFile = () => join(userData(), 'apikey.bin');

function loadSettings(): { settings: Partial<Settings>; apiKey?: string } {
  let settings: Partial<Settings> = {};
  if (existsSync(settingsFile())) settings = JSON.parse(readFileSync(settingsFile(), 'utf8'));
  if (process.env.SHORTSTUDIO_TEST_SETTINGS) settings = { ...settings, ...JSON.parse(process.env.SHORTSTUDIO_TEST_SETTINGS) }; // test hook
  let apiKey: string | undefined;
  if (existsSync(keyFile()) && safeStorage.isEncryptionAvailable()) apiKey = safeStorage.decryptString(readFileSync(keyFile()));
  return { settings, apiKey };
}

/** The key is encrypted with the OS keystore (DPAPI on Windows); it is never written as plain text. */
function saveSettings(s: Settings, apiKey: string | undefined): void {
  mkdirSync(dirname(settingsFile()), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
  if (apiKey && safeStorage.isEncryptionAvailable()) writeFileSync(keyFile(), safeStorage.encryptString(apiKey));
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360, height: 900, minWidth: 900, minHeight: 600, title: 'ShortStudio', backgroundColor: '#12131a',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // the page is a closed application: no popups, and it can never navigate away from itself
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:') && !url.startsWith(process.env.SHORTSTUDIO_DEV_URL ?? 'file:')) e.preventDefault(); });
  if (process.env.SHORTSTUDIO_DEV_URL) void win.loadURL(process.env.SHORTSTUDIO_DEV_URL);
  else void win.loadFile(join(__dirname, '../dist-renderer/index.html'));
  return win;
}

async function main() {
  if (process.env.SHORTSTUDIO_SOFTWARE_GL) {
    app.commandLine.appendSwitch('use-gl', 'angle');
    app.commandLine.appendSwitch('use-angle', 'swiftshader');
    app.commandLine.appendSwitch('enable-unsafe-swiftshader');
    app.commandLine.appendSwitch('ignore-gpu-blocklist');
  }
  await app.whenReady();

  const ffmpeg = bundledFfmpeg();
  if (ffmpeg) process.env.FFMPEG_PATH = ffmpeg; // the audio decoder reads this too

  const service: ProjectService = new ProjectService({
    provider: () => providerFromSettings(service.currentSettings.settings, service.currentSettings.apiKey),
    onSettings: saveSettings,
    ffmpeg,
  });
  const saved = loadSettings();
  service.restoreSettings(saved.settings, saved.apiKey);

  ipcMain.handle('svc', async (_e, method: string, args: unknown[]) => {
    if (!METHODS.has(method)) throw new Error(`unknown method "${method}"`);
    return (service as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!(...args);
  });
  ipcMain.handle('dialog:openDir', async (e) => {
    if (process.env.SHORTSTUDIO_TEST_PROJECT) return process.env.SHORTSTUDIO_TEST_PROJECT; // test hook: no native dialog
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender)!, { title: 'Open a ShortStudio project folder', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0]!;
  });
  ipcMain.handle('dialog:exportPath', async (e, defaultPath: string) => {
    if (process.env.SHORTSTUDIO_TEST_EXPORT) return process.env.SHORTSTUDIO_TEST_EXPORT;
    const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender)!, { title: 'Export video', defaultPath, filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
    return r.canceled || !r.filePath ? null : r.filePath;
  });

  if (app.isPackaged) Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

main().catch((e) => {
  console.error(e);
  app.exit(1);
});
