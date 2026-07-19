/*
 * Electron main process——单实例；抓取/解析/规则引擎/AI 全部在本进程（后续 issue 落地），
 * renderer 只经 preload 白名单桥通信（AGENTS 架构基线）。无内嵌 HTTP 层。
 * VISAPAW_SMOKE=1 时窗口 ready 后自动退出（CI/本机冒烟用）。
 */

import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, safeStorage, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createSettingsStore, PROVIDER_IDS, type SettingsStore, type ProviderId } from './settings-store.ts';
import { createCredentialStore, type CredentialStore, type SafeCrypto } from './credential-store.ts';
import { createLogStore, type LogStore } from './logging.ts';
import { createFetcher, type Fetcher } from './fetcher.ts';
import { createAiService, pingProvider, resolveModel } from './ai/orchestrator.ts';
import { AiError } from './ai/errors.ts';
import { generateChecklist, mapGenerateError, retranslateResult } from './pipeline.ts';
import { buildMarkdown, buildPlainText, buildPrintHtml } from './exporter.ts';
import type { ExportOutcome, GenerateOutcome, GenerateParams, GenerateResult, KeyTestResult, ProgressEvent } from '../common/types.ts';

const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5274';

/** 导出 payload 深层校验——覆盖 exporter 实际触达的全部嵌套字段（Kimi PR#30 P2 comment） */
function isExportableResult(raw: unknown): raw is GenerateResult {
  const r = raw as GenerateResult;
  return Boolean(
    r &&
      typeof r.checklistType === 'string' &&
      typeof r.fetchedAt === 'string' &&
      r.params &&
      typeof r.params.country?.key === 'string' &&
      typeof r.params.country?.value === 'string' &&
      (r.params.school === 'undecided' ||
        (typeof r.params.school?.key === 'string' && typeof r.params.school?.value === 'string')) &&
      typeof r.params.studentTypeCode === 'string' &&
      Array.isArray(r.generalNotes) &&
      r.generalNotes.every(
        (n) => typeof n?.note === 'string' && (n.level === 'normal' || n.level === 'warning')
      ) &&
      Array.isArray(r.aiMetas) &&
      Array.isArray(r.groups) &&
      r.groups.every(
        (g) =>
          typeof g?.category === 'string' &&
          Array.isArray(g?.sections) &&
          g.sections.every(
            (s) =>
              typeof s?.name === 'string' &&
              Array.isArray(s?.items) &&
              s.items.every(
                (i) =>
                  typeof i?.en === 'string' &&
                  Array.isArray(i?.links) &&
                  i.links.every((l) => typeof l?.text === 'string' && typeof l?.href === 'string') &&
                  Array.isArray(i?.notes) &&
                  i.notes.every((n) => typeof n?.note === 'string')
              )
          )
      )
  );
}

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
      // 状态 C WebView 降级（#13）——SPEC §4 安全约束在 web-contents-created 中施加
      webviewTag: true,
    },
  });

  const builtIndex = path.join(__dirname, '../dist-renderer/index.html');
  // smoke 模式优先加载已构建产物——验证真实 renderer + token 渲染，无需 dev server
  if (app.isPackaged || (process.env.VISAPAW_SMOKE === '1' && fs.existsSync(builtIndex))) {
    void win.loadFile(builtIndex);
  } else {
    void win.loadURL(DEV_URL);
  }

  // 外链（官网原文 ↗ 及清单内官方链接，如 legislation.gov.au）交系统浏览器；
  // 链接均源于官网页面内容，HTTPS 即放行，窗口内一律不导航（Codex PR#27 P2）
  const openExternally = (url: string): void => {
    if (url.startsWith('https://')) {
      shell.openExternal(url).catch((err: unknown) => {
        console.error('[visapaw] openExternal 失败：', err);
      });
    }
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });
  // will-navigate 兜底：普通 <a href> / location 跳转不受 windowOpenHandler 管辖（Kimi PR#27 P2）
  win.webContents.on('will-navigate', (ev, url) => {
    const isApp = url.startsWith(DEV_URL) || url.startsWith('file://');
    if (!isApp) {
      ev.preventDefault();
      openExternally(url);
    }
  });

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
  // 单 provider 连接测试（设置页「测试」按钮）——用户显式触发的最小真实 ping；
  // key 只在 main 侧读取，不跨 IPC（#12 决议不破）
  let activeKeyTest = false;
  ipcMain.handle('credentials:test', async (_e, provider: unknown): Promise<KeyTestResult> => {
    assertProvider(provider);
    if (activeKeyTest) return { ok: false, message: '已有测试进行中，请稍候' };
    const apiKey = credentials.getKey(provider);
    if (!apiKey) return { ok: false, message: '尚未保存 API key' };
    const setting = settings.get().providers.find((p) => p.id === provider);
    const model = resolveModel(provider, setting?.model ?? '');
    activeKeyTest = true;
    try {
      await pingProvider({ id: provider, apiKey, model });
      return { ok: true, model };
    } catch (e) {
      const kindLabel: Record<string, string> = {
        auth: '认证失败（API key 无效或无权限）',
        'rate-limit': '已连通但被限流',
        quota: '已连通但套餐额度不足',
        server: '服务端错误',
        parse: '已连通但输出格式异常',
        network: '网络不可达（检查网络或 base URL）',
      };
      const err = e instanceof AiError ? e : null;
      return {
        ok: false,
        message: err
          ? `${kindLabel[err.kind] ?? err.kind}：${err.message}`
          : (e as Error)?.message ?? String(e),
      };
    } finally {
      activeKeyTest = false;
    }
  });
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

  // 生成管线（#10）——进度流式推送，取消协作式；同一时刻仅一次生成
  let activeCancel: { cancelled: boolean } | null = null;
  ipcMain.handle('generate:start', async (e, raw: unknown): Promise<GenerateOutcome> => {
    if (activeCancel) return { ok: false, kind: 'unknown', message: '已有生成任务进行中' };
    // 严格边界校验——畸形参数不得流向官网接口（Kimi PR#26 P2）
    const p = raw as GenerateParams;
    const isTerm = (t: unknown): t is { key: string; value: string } =>
      !!t && typeof (t as { key?: unknown }).key === 'string' && typeof (t as { value?: unknown }).value === 'string';
    if (
      !isTerm(p?.country) ||
      !(p?.school === 'undecided' || isTerm(p?.school)) ||
      typeof p?.studentTypeCode !== 'string' ||
      !/^0[1-5]$/.test(p.studentTypeCode)
    ) {
      return { ok: false, kind: 'unknown', message: '生成参数不完整或不合法' };
    }
    const cancel = { cancelled: false };
    const sender = e.sender;
    const onProgress = (ev: ProgressEvent): void => {
      if (!sender.isDestroyed()) sender.send('generate:progress', ev);
    };
    try {
      // 锁在 try 内取得——中途抛错也必由 finally 释放（Kimi PR#26 P2）
      activeCancel = cancel;
      const run = logs.startRun({
        country: p.country.value,
        cricosCode: p.school === 'undecided' ? '未定' : p.school.value,
        studentTypeCode: p.studentTypeCode,
      });
      try {
        const result = await generateChecklist(
          p,
          {
            fetcher,
            createAiService: (onEvent) =>
              createAiService({
                settings: settings.get(),
                getKey: (id) => credentials.getKey(id),
                onEvent,
              }),
            run,
          },
          onProgress,
          cancel
        );
        // 保留英文清单仍是可用结果——run 记 success，翻译失败以标志区分（Kimi PR#26 P2）
        run.finish('success', {
          checklistType: result.checklistType,
          translationFailed: result.translationFailed,
        });
        return { ok: true, result };
      } catch (err) {
        run.finish('error');
        throw err;
      }
    } catch (err) {
      // 错误种类结构化跨 IPC——#13 三态 UI 按类型驱动（非字符串匹配）
      return { ok: false, ...mapGenerateError(err) };
    } finally {
      activeCancel = null;
    }
  });
  // 状态 D：仅重试翻译，不重新抓取（#13）——与生成共用互斥锁（Codex PR#29 P2）
  ipcMain.handle('generate:retry-translation', async (_e, raw: unknown): Promise<GenerateOutcome> => {
    if (activeCancel) return { ok: false, kind: 'unknown', message: '已有生成任务进行中' };
    // 与导出同一深层校验——缺 generalNotes 等字段的畸形结果不得流入重译链（Kimi PR#32 P2）
    if (!isExportableResult(raw)) {
      return { ok: false, kind: 'unknown', message: '重试参数不合法' };
    }
    const prev = raw;
    const lock = { cancelled: false };
    activeCancel = lock;
    const run = logs.startRun({
      country: prev.params.country.value,
      cricosCode: prev.params.school === 'undecided' ? '未定' : prev.params.school.value,
      studentTypeCode: prev.params.studentTypeCode,
    });
    try {
      const result = await retranslateResult(
        prev,
        {
          run,
          createAiService: (onEvent) =>
            createAiService({
              settings: settings.get(),
              getKey: (id) => credentials.getKey(id),
              onEvent,
            }),
        },
        undefined,
        lock // 取消令牌贯通重试路径（Kimi PR#29 minor）
      );
      run.finish('success', { checklistType: result.checklistType, translationFailed: false });
      return { ok: true, result };
    } catch (err) {
      run.finish('error');
      return { ok: false, ...mapGenerateError(err) };
    } finally {
      activeCancel = null;
    }
  });
  ipcMain.handle('generate:cancel', () => {
    if (activeCancel) activeCancel.cancelled = true;
  });

  // 导出（#14）——markdown/pdf 保存框写文件；copy 剪贴板双格式
  let activeExport = false; // 并发互斥：防重复保存框/并发隐藏窗口（Kimi PR#30 P2）
  ipcMain.handle('export:result', async (_e, kind: unknown, raw: unknown): Promise<ExportOutcome> => {
    // 深层结构校验后再断言——顶层三字段不足以防畸形 payload 在 exporter
    // 深处抛运行时异常（Kimi PR#30 P2 comment）
    if (!isExportableResult(raw)) return { ok: false, message: '导出数据格式不正确' };
    const result = raw;
    if (activeExport) return { ok: false, message: '已有导出进行中，请稍候' };
    activeExport = true;
    // 保存框挂到可见主窗口上，防 macOS 下对话框落到主窗口后方（Kimi PR#30 minor）
    const owner = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible());
    try {
      if (kind === 'copy') {
        clipboard.write({ text: buildPlainText(result), html: buildPrintHtml(result) });
        return { ok: true };
      }
      if (kind === 'markdown') {
        const opts = {
          defaultPath: `澳大利亚学生签证材料清单-${result.checklistType}.md`,
          filters: [{ name: 'Markdown', extensions: ['md'] }],
        };
        const { canceled, filePath } = owner
          ? await dialog.showSaveDialog(owner, opts)
          : await dialog.showSaveDialog(opts);
        if (canceled || !filePath) return { ok: false, cancelled: true, message: '已取消' };
        // 异步写盘——同步写会阻塞 main 进程事件循环与全部 IPC（Kimi PR#30 P2）
        await fs.promises.writeFile(filePath, buildMarkdown(result), 'utf8');
        return { ok: true, path: filePath };
      }
      if (kind === 'pdf') {
        const opts = {
          defaultPath: `澳大利亚学生签证材料清单-${result.checklistType}.pdf`,
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        };
        const { canceled, filePath } = owner
          ? await dialog.showSaveDialog(owner, opts)
          : await dialog.showSaveDialog(opts);
        if (canceled || !filePath) return { ok: false, cancelled: true, message: '已取消' };
        // 隐藏窗口渲染专用打印模板 → printToPDF（无额外依赖，SPEC §8）。
        // 经临时文件 loadFile 而非 data: URL——长清单会逼近 Chromium data URL
        // 长度上限导致 loadURL 失败（Kimi PR#30 minor）。视口取 A4 @96dpi，
        // 防默认视口影响打印布局（Kimi PR#30 minor）
        const printWin = new BrowserWindow({
          show: false,
          width: 794,
          height: 1123,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        const tmpHtml = path.join(app.getPath('temp'), `visapaw-print-${Date.now()}.html`);
        try {
          await fs.promises.writeFile(tmpHtml, buildPrintHtml(result), 'utf8');
          await printWin.loadFile(tmpHtml);
          const pdf = await printWin.webContents.printToPDF({
            pageSize: 'A4',
            printBackground: true,
          });
          // 异步写盘——同步写会阻塞 main 进程事件循环与全部 IPC（Kimi PR#30 P2）
          await fs.promises.writeFile(filePath, pdf);
        } finally {
          printWin.destroy();
          await fs.promises.rm(tmpHtml, { force: true });
        }
        return { ok: true, path: filePath };
      }
      return { ok: false, message: `未知导出类型：${String(kind)}` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    } finally {
      activeExport = false;
    }
  });
  ipcMain.handle('system:status', () => ({
    dark: nativeTheme.shouldUseDarkColors,
    version: app.getVersion(),
  }));
}

function isOfficialUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'immi.homeaffairs.gov.au';
  } catch {
    return false;
  }
}

app.setAppUserModelId('com.alvinshen.visapaw');

// WebView 降级安全约束（SPEC §4/#13）：导航限制在 immi.homeaffairs.gov.au 域内、
// 弹窗一律外部打开、不允许附加 preload（App 不采集个人信息的红线在降级模式同样成立）
app.on('web-contents-created', (_e, contents) => {
  // 嵌入方：剥离任何 webview preload/node 集成企图
  contents.on('will-attach-webview', (_ev, webPreferences) => {
    delete (webPreferences as { preload?: string }).preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true; // 嵌入内容强制沙箱（Kimi PR#29 minor）
  });
  if (contents.getType() !== 'webview') return;
  contents.on('will-navigate', (ev, url) => {
    // hostname 精确匹配——前缀比较可被 immi.homeaffairs.gov.au.evil.com 欺骗（Kimi PR#29 P2）
    if (!isOfficialUrl(url)) ev.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      shell.openExternal(url).catch(() => undefined);
    }
    return { action: 'deny' };
  });
});

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
