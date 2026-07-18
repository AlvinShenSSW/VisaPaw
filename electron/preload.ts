/*
 * Preload 桥——renderer 可见的唯一表面。contextIsolation 开启；
 * renderer 拿不到 Node、拿不到 key 明文（status 仅 saved/prefix，#12 决议）。
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ProgressEvent, VisapawBridge } from '../common/types.ts';

const bridge: VisapawBridge = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  setProviderKey: (provider, key) => ipcRenderer.invoke('credentials:set', provider, key),
  deleteProviderKey: (provider) => ipcRenderer.invoke('credentials:delete', provider),
  getProviderKeyStatus: () => ipcRenderer.invoke('credentials:status'),
  getSystemStatus: () => ipcRenderer.invoke('system:status'),
  getTerms: (kind) => ipcRenderer.invoke('terms:get', kind),
  startGenerate: (params) => ipcRenderer.invoke('generate:start', params),
  cancelGenerate: () => ipcRenderer.invoke('generate:cancel'),
  onGenerateProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, ev: ProgressEvent): void => cb(ev);
    ipcRenderer.on('generate:progress', listener);
    return () => ipcRenderer.removeListener('generate:progress', listener);
  },
  listRunLogs: () => ipcRenderer.invoke('logs:list'),
  getRunLog: (id) => ipcRenderer.invoke('logs:get', id),
  exportRunLog: (id) => ipcRenderer.invoke('logs:export', id),
  clearRunLogs: () => ipcRenderer.invoke('logs:clear'),
};

contextBridge.exposeInMainWorld('visapaw', bridge);
