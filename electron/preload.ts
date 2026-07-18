/*
 * Preload 桥——renderer 可见的唯一表面。contextIsolation 开启；
 * renderer 拿不到 Node、拿不到 key 明文（status 仅 saved/prefix，#12 决议）。
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { Settings, ProviderId } from './settings-store.ts';
import type { KeyStatus } from './credential-store.ts';

export interface VisapawBridge {
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  setProviderKey(provider: ProviderId, key: string): Promise<Record<ProviderId, KeyStatus>>;
  deleteProviderKey(provider: ProviderId): Promise<Record<ProviderId, KeyStatus>>;
  getProviderKeyStatus(): Promise<Record<ProviderId, KeyStatus>>;
  getSystemStatus(): Promise<{ dark: boolean; version: string }>;
}

const bridge: VisapawBridge = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  setProviderKey: (provider, key) => ipcRenderer.invoke('credentials:set', provider, key),
  deleteProviderKey: (provider) => ipcRenderer.invoke('credentials:delete', provider),
  getProviderKeyStatus: () => ipcRenderer.invoke('credentials:status'),
  getSystemStatus: () => ipcRenderer.invoke('system:status'),
};

contextBridge.exposeInMainWorld('visapaw', bridge);
