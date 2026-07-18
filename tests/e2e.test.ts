/*
 * #16 端到端集成验收——真实 fetcher（fixture 回放）+ 真实 orchestrator（SDK 适配器替身）
 * + 真实 parser/classifier/annotator/LogStore，贯通「判定→抓取→解析→分类→备注→翻译→组装」。
 * 五场景：正常 / fallback / 取消 / 降级（含待人工归类）/ 导出一致性。
 * 红线：不发真实请求（官网走 fixture、AI 全替身）；三要素在全部场景断言不缺失。
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createFetcher } from '../electron/fetcher.ts';
import {
  createAiService,
  type AiEvent,
  type AiService,
} from '../electron/ai/orchestrator.ts';
import type { ProviderAdapter, StructuredCall } from '../electron/ai/adapters.ts';
import { AiError } from '../electron/ai/errors.ts';
import { createLogStore } from '../electron/logging.ts';
import { CancelledError, generateChecklist, mapGenerateError } from '../electron/pipeline.ts';
import { buildMarkdown, buildPlainText, buildPrintHtml } from '../electron/exporter.ts';
import { buildDisplayGroups, formatFetchedAt } from '../common/result-view.ts';
import { CATEGORIES, PENDING_MANUAL_CATEGORY } from '../electron/classifier.ts';
import type {
  GenerateParams,
  GenerateResult,
  ProgressEvent,
  ProviderId,
  Settings,
} from '../common/types.ts';

const FIX = join(process.cwd(), 'tests', 'fixtures');
const typeJson = readFileSync(join(FIX, 'checklist-type-chn-notlisted.json'), 'utf8');
const pageHtml = gunzipSync(readFileSync(join(FIX, 'evidentiary-tool.html.gz'))).toString('utf8');

const PARAMS: GenerateParams = {
  country: { key: 'China', value: 'CHN' },
  school: 'undecided',
  studentTypeCode: '01',
};
const RUN_PARAMS = { country: 'CHN', cricosCode: ' ', studentTypeCode: '01' };
const T0 = Date.UTC(2026, 6, 19, 6, 0, 0);

const tmp = (tag: string): string => mkdtempSync(join(tmpdir(), `visapaw-e2e-${tag}-`));

/** 官网 fixture 回放 fetcher——真实 createFetcher，仅注入 fetchImpl（红线 1：无真实请求） */
function replayFetcher(html: string = pageHtml) {
  const fetchImpl = vi.fn().mockImplementation((url: unknown) => {
    const u = String(url);
    if (u.includes('GetStudentDocumentChecklistType')) {
      return Promise.resolve(new Response(typeJson, { status: 200 }));
    }
    if (u.includes('/visas/web-evidentiary-tool')) {
      return Promise.resolve(new Response(html, { status: 200 }));
    }
    return Promise.reject(new Error(`E2E 未预期的请求：${u}`));
  });
  const fetcher = createFetcher({ cacheDir: tmp('cache'), fetchImpl, now: () => T0 });
  return { fetcher, fetchImpl };
}

/** provider 替身行为：接到结构化调用返回 raw JSON（经真实 orchestrator zod 校验） */
type Behavior = (call: StructuredCall) => Promise<unknown>;

const itemsOf = (call: StructuredCall): string[] => {
  // 与 translateUserPrompt 模板耦合的显式假定——模板变更时给出可读失败（Kimi PR#31 minor）
  const jsonLine = call.user.split('\n').find((l) => l.trimStart().startsWith('['));
  if (!jsonLine) {
    throw new Error('E2E 替身假定 translateUserPrompt 含 JSON 数组行——prompt 模板已变更，请同步 itemsOf');
  }
  return JSON.parse(jsonLine) as string[];
};

const okBehavior =
  (prefix: string): Behavior =>
  async (call) => {
    if (call.schemaName === 'translate_result') {
      return { translations: itemsOf(call).map((t) => `${prefix}${t.slice(0, 8)}`) };
    }
    return { category: CATEGORIES[1] };
  };

const failBehavior =
  (kind: 'quota' | 'server', id: ProviderId): Behavior =>
  async () => {
    throw new AiError(kind, `${id} ${kind} 注入失败`, id);
  };

/**
 * 真实 orchestrator + 替身适配器（AI 红线：全 mock）。返回 pipeline 需要的
 * createAiService(onEvent) 工厂；events 汇总链路事件供断言。
 */
function makeAiFactory(
  behaviors: Partial<Record<ProviderId, Behavior>>,
  events: AiEvent[] = []
): { createAi: (onEvent: (e: AiEvent) => void) => AiService; calls: Record<string, number> } {
  const settings: Pick<Settings, 'providers'> = {
    providers: [
      { id: 'claude', enabled: true, model: '' },
      { id: 'openai', enabled: true, model: '' },
      { id: 'mimo', enabled: false, model: '' },
    ],
  };
  const calls: Record<string, number> = {};
  const createAi = (onEvent: (e: AiEvent) => void): AiService =>
    createAiService({
      settings,
      getKey: () => 'e2e-key',
      onEvent: (e) => {
        events.push(e);
        onEvent(e);
      },
      adapterFactory: (spec): ProviderAdapter => ({
        id: spec.id,
        model: spec.model,
        callStructured: (call) => {
          calls[spec.id] = (calls[spec.id] ?? 0) + 1;
          const behavior = behaviors[spec.id] ?? failBehavior('server', spec.id);
          return behavior(call);
        },
      }),
    });
  return { createAi, calls };
}

function collect(): { events: ProgressEvent[]; onProgress: (e: ProgressEvent) => void } {
  const events: ProgressEvent[] = [];
  return { events, onProgress: (e) => events.push(e) };
}

/** 红线三要素——任何场景的结果与导出物都不得缺失（验收标准 2） */
function expectThreeElements(result: GenerateResult): void {
  expect(result.checklistType).toBe('Streamlined');
  expect(new Date(result.fetchedAt).toISOString()).toBe(result.fetchedAt);
  for (const text of [buildMarkdown(result), buildPlainText(result), buildPrintHtml(result)]) {
    expect(text).toContain('Streamlined');
    expect(text).toContain(formatFetchedAt(result.fetchedAt));
    expect(text).toContain('免责声明');
    expect(text).toContain('不构成移民建议');
  }
}

describe('场景 1：正常链路（CHN + 未定 → Streamlined 七大分类双语清单 + 完整日志链）', () => {
  it('结果结构完整；三要素齐备；一次成功生成形成完整阶段日志链（联动 #15）', async () => {
    const { fetcher, fetchImpl } = replayFetcher();
    const { createAi } = makeAiFactory({ claude: okBehavior('【中文】') });
    let clock = T0;
    const store = createLogStore(tmp('logs'), { now: () => (clock += 500) });
    const run = store.startRun(RUN_PARAMS);
    const { events, onProgress } = collect();

    const result = await generateChecklist(PARAMS, { fetcher, createAiService: createAi, run }, onProgress);
    run.finish('success', {
      checklistType: result.checklistType,
      translationFailed: result.translationFailed,
    });

    // 官网只发生 fixture 回放的两次请求：判定 + 抓取（红线：低频、无多余请求）
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // 结果数据结构完整：分组非空、按七大分类顺序、逐条双语 + 备注注入
    expect(result.translationFailed).toBe(false);
    expect(result.groups.length).toBeGreaterThan(0);
    const order = [...CATEGORIES, PENDING_MANUAL_CATEGORY] as string[];
    const idxs = result.groups.map((g) => order.indexOf(g.category));
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
    expect(idxs.every((i) => i >= 0)).toBe(true);
    const items = result.groups.flatMap((g) => g.sections.flatMap((s) => s.items));
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.en.length > 0 && i.zh?.startsWith('【中文】'))).toBe(true);
    expect(items.some((i) => i.notes.length > 0)).toBe(true);
    expect(result.aiMeta?.provider).toBe('claude');
    expect(result.aiMetas).toHaveLength(1);

    // 三要素（结果 + 三种导出物）
    expectThreeElements(result);

    // 进度事件两阶段闭合
    const kinds = events.map((e) => (e.type === 'phase' ? `${e.phase}:${e.status}` : e.type));
    expect(kinds[0]).toBe('search:active');
    expect(kinds).toContain('search:done');
    expect(kinds.at(-1)).toBe('translate:done');

    // 完整阶段日志链（验收标准 3）
    const [summary] = store.listRuns();
    expect(summary).toMatchObject({ status: 'success', checklistType: 'Streamlined' });
    const stages = store.getRun(summary.id)!.entries.map((e) => e.stage);
    for (const stage of ['判定', '抓取', '解析', '分类', '备注', '翻译', '完成']) {
      expect(stages).toContain(stage);
    }
    expect(stages.at(-1)).toBe('完成');
  });
});

describe('场景 2：fallback 链路（首选 provider 配额耗尽 → 自动切换，元信息记录实际 provider）', () => {
  it('claude quota → openai 接手；fallback 事件带下家；三要素不缺失', async () => {
    const { fetcher } = replayFetcher();
    const aiEvents: AiEvent[] = [];
    const { createAi, calls } = makeAiFactory(
      { claude: failBehavior('quota', 'claude'), openai: okBehavior('〔译〕') },
      aiEvents
    );
    const { events, onProgress } = collect();

    const result = await generateChecklist(
      PARAMS,
      { fetcher, createAiService: createAi },
      onProgress
    );

    // 元信息记录实际成功的 provider（红线 5）
    expect(result.aiMeta?.provider).toBe('openai');
    expect(result.aiMetas.map((m) => m.provider)).toContain('openai');
    expect(result.translationFailed).toBe(false);
    expect(calls.claude).toBeGreaterThan(0);
    expect(calls.openai).toBeGreaterThan(0);

    // fallback 事件链完整：quota 触发、指向下家 openai；UI 侧收到 fallback-note
    const fb = aiEvents.find((e) => e.type === 'fallback');
    expect(fb).toMatchObject({ provider: 'claude', errorKind: 'quota', next: 'openai' });
    expect(events.some((e) => e.type === 'fallback-note' && e.to === 'openai')).toBe(true);

    expectThreeElements(result);
  });
});

describe('场景 3：取消链路（Step 2 取消 → 中断且无悬挂请求）', () => {
  it('首批译后取消 → CancelledError；后续批次与官网请求均不再发生', async () => {
    const { fetcher, fetchImpl } = replayFetcher();
    const { createAi, calls } = makeAiFactory({ claude: okBehavior('【中文】') });
    const cancel = { cancelled: false };
    const onProgress = (e: ProgressEvent): void => {
      if (e.type === 'translate-progress') cancel.cancelled = true; // 模拟 Step 2 点取消
    };

    await expect(
      generateChecklist(PARAMS, { fetcher, createAiService: createAi }, onProgress, cancel)
    ).rejects.toThrow(CancelledError);

    // 无悬挂请求：官网仅判定+抓取两次；翻译在首批后即停（分类映射全命中不耗 AI）
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(calls.claude).toBe(1);
    // 错误映射为结构化 cancelled（UI 返回 Step 1，不进错误视图）
    expect(mapGenerateError(new CancelledError()).kind).toBe('cancelled');
  });

  it('抓取阶段取消 → 判定后即中断，清单页与 AI 均不再请求（Kimi PR#31 P2）', async () => {
    const { fetcher, fetchImpl } = replayFetcher();
    const { createAi, calls } = makeAiFactory({ claude: okBehavior('【中文】') });
    const cancel = { cancelled: false };
    const onProgress = (e: ProgressEvent): void => {
      // search 阶段一开始即取消——覆盖判定/抓取间的取消检查点
      if (e.type === 'phase' && e.phase === 'search' && e.status === 'active') {
        cancel.cancelled = true;
      }
    };

    await expect(
      generateChecklist(PARAMS, { fetcher, createAiService: createAi }, onProgress, cancel)
    ).rejects.toThrow(CancelledError);

    // 判定请求已在途完成即中断；1.4MB 清单页与任何 AI 调用均未发生
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calls.claude ?? 0).toBe(0);
  });
});

describe('场景 4：降级链路（全 provider 失败 → 英文清单 + 分类备注仍注入 + 待人工归类）', () => {
  it('translationFailed 状态 D；映射未命中且 AI 兜底不可用的章节归入「待人工归类」', async () => {
    // fixture 定向变异：把 Streamlined 内已映射章节名改为映射表外名称，触发 AI 兜底路径。
    // 前置断言变异确实命中——fixture 标记形态变化时立即显性失败（Kimi PR#31 minor）
    const mutated = pageHtml.replaceAll('>Health insurance<', '>Quantum Compliance<');
    expect(mutated).not.toBe(pageHtml);
    const { fetcher } = replayFetcher(mutated);
    const { createAi } = makeAiFactory({}); // 全部 provider server 失败
    let clock = T0;
    const store = createLogStore(tmp('logs-degraded'), { now: () => (clock += 300) });
    const run = store.startRun(RUN_PARAMS);

    const result = await generateChecklist(PARAMS, { fetcher, createAiService: createAi, run });
    run.finish('success', { checklistType: result.checklistType, translationFailed: true });

    // 状态 D：翻译失败但英文清单完整，分类与备注（确定性，不依赖 AI）仍注入
    expect(result.translationFailed).toBe(true);
    expect(result.aiMeta).toBeNull();
    const items = result.groups.flatMap((g) => g.sections.flatMap((s) => s.items));
    expect(items.every((i) => i.zh === undefined && i.en.length > 0)).toBe(true);
    expect(items.some((i) => i.notes.length > 0)).toBe(true);

    // 待人工归类殿后（#6/#13 决议：AI 兜底不可用 → pendingManual）
    const last = result.groups.at(-1)!;
    expect(last.category).toBe(PENDING_MANUAL_CATEGORY);
    expect(last.sections.some((s) => s.name === 'Quantum Compliance' && s.pendingManual)).toBe(true);

    // 三要素在降级态同样不缺失；导出物明示「暂不可用」
    expectThreeElements(result);
    expect(buildMarkdown(result)).toContain('暂不可用');

    // 日志链含翻译失败终态说明
    const [summary] = store.listRuns();
    expect(summary.translationFailed).toBe(true);
    const entries = store.getRun(summary.id)!.entries;
    expect(entries.some((e) => e.stage === '翻译' && e.level === 'err')).toBe(true);
  });
});

describe('场景 5：导出一致性（Markdown / 纯文本(剪贴板) / 打印 HTML(PDF) 与结果视图逐条一致）', () => {
  it('三种导出物与 buildDisplayGroups 展示模型编号、内容、分组逐条一致', async () => {
    const { fetcher } = replayFetcher();
    const { createAi } = makeAiFactory({ claude: okBehavior('【中文】') });
    const result = await generateChecklist(PARAMS, { fetcher, createAiService: createAi });

    const groups = buildDisplayGroups(result);
    const rows = groups.flatMap((g) => g.items);
    const md = buildMarkdown(result);
    const plain = buildPlainText(result);
    const html = buildPrintHtml(result);

    // 连续编号完整：1..N；编号与条目全文作为同一行断言且按序出现——
    // 独立 toContain 在行序错乱/同前缀互换时仍会通过（Codex PR#31 P2）
    expect(rows.map((r) => r.no)).toEqual(rows.map((_, i) => i + 1));
    const mdEsc = (s: string): string =>
      s.replace(/([\\`*_[\]#])/g, '\\$1').replace(/\n/g, ' ');
    const htmlEsc = (s: string): string =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    let prevPlain = -1;
    let prevMd = -1;
    let prevHtml = -1;
    for (const row of rows) {
      const main = row.item.zh ?? row.item.en;
      const plainPos = plain.indexOf(`\n${row.no}. ${main}`);
      expect(plainPos).toBeGreaterThan(prevPlain);
      prevPlain = plainPos;
      const mdPos = md.indexOf(`\n${row.no}. ${mdEsc(main)}`);
      expect(mdPos).toBeGreaterThan(prevMd);
      prevMd = mdPos;
      const htmlPos = html.indexOf(`>${row.no}.</span><span class="zh">${htmlEsc(main)}`);
      expect(htmlPos).toBeGreaterThan(prevHtml);
      prevHtml = htmlPos;
    }
    // 行数精确相等——重复/缺行在单调位置断言下仍可能漏检（Kimi PR#31 P2）
    expect(plain.match(/\n\d+\. /g)).toHaveLength(rows.length);
    expect(md.match(/\n\d+\. /g)).toHaveLength(rows.length);
    expect(html.match(/<span class="no">/g)).toHaveLength(rows.length);
    // 分组标题与条数一致
    for (const g of groups) {
      expect(md).toContain(g.category);
      expect(plain).toContain(g.category);
      expect(html).toContain(`${g.itemCount} 项`);
    }
    // 实际 provider 溯源出现在全部导出物（红线 5）
    for (const text of [md, plain, html]) {
      expect(text).toContain(result.aiMeta!.model);
    }
  });
});
