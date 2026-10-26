/**
 * Runs in the page's isolated world. The page gets exactly four capabilities and nothing else: call a service method,
 * and two native dialogs. No Node, no filesystem, no `require`.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('shortstudio', {
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('svc', method, args),
  pickProjectDir: () => ipcRenderer.invoke('dialog:openDir') as Promise<string | null>,
  pickExportPath: (defaultPath: string) => ipcRenderer.invoke('dialog:exportPath', defaultPath) as Promise<string | null>,
});
