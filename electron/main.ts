/*
 * Electron main process——单实例；抓取/解析/规则引擎/AI 全部在本进程（后续 issue 落地），
 * renderer 只经 preload 白名单桥通信（AGENTS 架构基线）。无内嵌 HTTP 层。
 * VISAPAW_SMOKE=1 时窗口 ready 后自动退出（CI/本机冒烟用）。
 */

import { app, BrowserWindow, ipcMain, nativeTheme, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createSettingsStore, PROVIDER_IDS, type SettingsStore, type ProviderId } from './settings-store.ts';
import { createCredentialStore, type CredentialStore, type SafeCrypto } from './credential-store.ts';
import { createLogStore, type LogStore } from './logging.ts';
import { createFetcher, type Fetcher } from './fetcher.ts';

const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5274';

let settings: SettingsStore;
let credentials: CredentialStore;
let logs: LogStore;
let fetcher: Fetcher;

function initStores(): void {
  const userData = app.getPath('userData');
  const crypto: SafeCrypto = {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  };
  settings = createSettingsStore(path.join(userData, 'settings.json'));
  credentials = createCredentialStore(path.join(userData, 'credentials.bin'), crypto);
  logs = createLogStore(path.join(userData, 'logs'));
  fetcher = createFetcher({ cacheDir: path.join(userData, 'terms-cache') });
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
    // renderer 加载失败必须响亮失败（Kimi 终审 minor）
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      console.error(`[visapaw] smoke: renderer 加载失败（${code} ${desc}），exit 1`);
      app.exit(1);
    });
  }
}

// vault 写操作串行化——不依赖底层 IO 恰好同步（Kimi 终审 P2）
let vaultLock: Promise<unknown> = Promise.resolve();
function withVaultLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = vaultLock.then(fn, fn);
  vaultLock = run.catch(() => undefined);
  return run;
}

// IPC 边界校验：renderer 参数先验证再进 store（Kimi 终审 P2）
function assertProvider(v: unknown): asserts v is ProviderId {
  if (!(PROVIDER_IDS as readonly string[]).includes(v as string)) {
    throw new Error(`无效的 provider 参数：${String(v)}`);
  }
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (_e, patch: unknown) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('settings patch 必须是对象');
    }
    return settings.set(patch);
  });
  // key 单向写入；renderer 永远拿不到 key 明文（#12 决议）
  ipcMain.handle('credentials:set', (_e, provider: unknown, key: unknown) => {
    assertProvider(provider);
    if (typeof key !== 'string' || key.trim() === '') throw new Error('API key 不能为空');
    return withVaultLock(() => {
      credentials.setKey(provider, key);
      return credentials.getStatus();
    });
  });
  ipcMain.handle('credentials:delete', (_e, provider: unknown) => {
    assertProvider(provider);
    return withVaultLock(() => {
      credentials.deleteKey(provider);
      return credentials.getStatus();
    });
  });
  ipcMain.handle('credentials:status', () => credentials.getStatus());
  // Termstore 下拉数据（#9）——smoke 模式不发真实请求（低频红线）
  ipcMain.handle('terms:get', (_e, kind: unknown) => {
    if (kind !== 'countries' && kind !== 'cricos') throw new Error(`未知的 term kind：${String(kind)}`);
    if (process.env.VISAPAW_SMOKE === '1') return [];
    return fetcher.fetchTerms(kind);
  });
  // 生成日志（#15）——#12 日志标签页数据源
  ipcMain.handle('logs:list', () => logs.listRuns());
  ipcMain.handle('logs:get', (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('运行 id 必须是字符串');
    return logs.getRun(id);
  });
  ipcMain.handle('logs:export', (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('运行 id 必须是字符串');
    return logs.exportRun(id);
  });
  ipcMain.handle('logs:clear', () => logs.clear());
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
