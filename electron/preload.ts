/*
 * Preload 桥——renderer 可见的唯一表面。contextIsolation 开启；
 * renderer 拿不到 Node、拿不到 key 明文（status 仅 saved/prefix，#12 决议）。
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { VisapawBridge } from '../common/types.ts';

const bridge: VisapawBridge = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  setProviderKey: (provider, key) => ipcRenderer.invoke('credentials:set', provider, key),
  deleteProviderKey: (provider) => ipcRenderer.invoke('credentials:delete', provider),
  getProviderKeyStatus: () => ipcRenderer.invoke('credentials:status'),
  getSystemStatus: () => ipcRenderer.invoke('system:status'),
};

contextBridge.exposeInMainWorld('visapaw', bridge);
