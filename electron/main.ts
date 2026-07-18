/*
 * Electron main process——单实例；抓取/解析/规则引擎/AI 全部在本进程（后续 issue 落地），
 * renderer 只经 preload 白名单桥通信（AGENTS 架构基线）。无内嵌 HTTP 层。
 * VISAPAW_SMOKE=1 时窗口 ready 后自动退出（CI/本机冒烟用）。
 */

import { app, BrowserWindow, ipcMain, nativeTheme, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createSettingsStore, type SettingsStore } from './settings-store.ts';
import { createCredentialStore, type CredentialStore, type SafeCrypto } from './credential-store.ts';
import type { ProviderId } from './settings-store.ts';

const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5274';

let settings: SettingsStore;
let credentials: CredentialStore;

function initStores(): void {
  const userData = app.getPath('userData');
  const crypto: SafeCrypto = {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  };
  settings = createSettingsStore(path.join(userData, 'settings.json'));
  credentials = createCredentialStore(path.join(userData, 'credentials.bin'), crypto);
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    title: 'VisaPaw',
    // #3 决议（PR #17 Kimi minor）：保留原生红绿灯，仅自定义标题区
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#232629' : '#F5F7FA',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const builtIndex = path.join(__dirname, '../dist-renderer/index.html');
  // smoke 模式优先加载已构建产物——验证真实 renderer + token 渲染，无需 dev server
  if (app.isPackaged || (process.env.VISAPAW_SMOKE === '1' && fs.existsSync(builtIndex))) {
    void win.loadFile(builtIndex);
  } else {
    void win.loadURL(DEV_URL);
  }

  if (process.env.VISAPAW_SMOKE === '1') {
    win.webContents.once('did-finish-load', () => {
      console.log('[visapaw] smoke: window loaded, exiting 0');
      app.quit();
    });
    // dev server 不在时 loadURL 会失败——冒烟只验证窗口/主进程生命周期
    win.webContents.once('did-fail-load', () => {
      console.log('[visapaw] smoke: renderer URL unavailable (window lifecycle ok), exiting 0');
      app.quit();
    });
  }
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (_e, patch: unknown) => settings.set(patch));
  // key 单向写入；renderer 永远拿不到 key 明文（#12 决议）
  ipcMain.handle('credentials:set', (_e, provider: ProviderId, key: string) => {
    credentials.setKey(provider, key);
    return credentials.getStatus();
  });
  ipcMain.handle('credentials:delete', (_e, provider: ProviderId) => {
    credentials.deleteKey(provider);
    return credentials.getStatus();
  });
  ipcMain.handle('credentials:status', () => credentials.getStatus());
  ipcMain.handle('system:status', () => ({
    dark: nativeTheme.shouldUseDarkColors,
    version: app.getVersion(),
  }));
}

app.setAppUserModelId('com.alvinshen.visapaw');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  // 生命周期监听在模块顶层注册，避免 ready 前的事件丢失（Kimi 终审 minor）
  app.on('activate', () => {
    if (app.isReady() && BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || process.env.VISAPAW_SMOKE === '1') app.quit();
  });
  app
    .whenReady()
    .then(() => {
      initStores();
      registerIpc();
      createWindow();
    })
    .catch((err: unknown) => {
      // 启动失败不能留下未定义状态（Kimi 终审 P2）
      console.error('[visapaw] 启动失败：', err);
      app.quit();
    });
}
