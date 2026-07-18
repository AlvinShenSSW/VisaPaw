/*
 * 生成管线（#10 落地进度契约；#16 补 E2E 场景）——
 * 判定 → 抓取 → 解析 → 分类 → 备注 → 翻译 → 结果组装。
 * Step 2 只见两阶段（search / translate）+ fallback 提示；细粒度过程写 #15 日志。
 * 取消：协作式令牌，阶段间与翻译分批间检查；在途单请求受 fetcher 20s 超时兜底。
 * 红线：AI 只收官网清单文本；三要素（抓取时间/清单类型/免责声明数据）齐备。
 */

import type {
  GenerateParams,
  GenerateResult,
  ProgressEvent,
  ResultGroup,
  ResultItem,
  ResultSection,
} from '../common/types.ts';
import type { Fetcher } from './fetcher.ts';
import { parseChecklist } from './parser.ts';
import {
  CATEGORIES,
  PENDING_MANUAL_CATEGORY,
  classifySections,
  type ClassifierEvent,
} from './classifier.ts';
import { DEFAULT_RULES, annotateItem } from './annotator.ts';
import { AiExhaustedError } from './ai/errors.ts';
import type { AiEvent, AiService } from './ai/orchestrator.ts';
import type { RunHandle } from './logging.ts';
import { aiEventToLog, classifierEventToLog } from './logging.ts';

/** 每批翻译条数——驱动 n/total 进度并限制单次调用规模 */
const TRANSLATE_BATCH_SIZE = 8;

/** 管线错误 → 结构化 outcome 种类（跨 IPC；#13 三态 UI 的类型驱动数据源） */
export function mapGenerateError(e: unknown): { kind: 'network' | 'forbidden' | 'structure' | 'cancelled' | 'unknown'; message: string } {
  if (e instanceof CancelledError) return { kind: 'cancelled', message: e.message };
  const kind = (e as { kind?: string })?.kind;
  if (kind === 'network' || kind === 'forbidden' || kind === 'structure') {
    return { kind, message: (e as Error).message };
  }
  return { kind: 'unknown', message: (e as Error)?.message ?? String(e) };
}

export class CancelledError extends Error {
  constructor() {
    super('生成已取消');
    this.name = 'CancelledError';
  }
}

export interface CancelToken {
  readonly cancelled: boolean;
}

export interface PipelineDeps {
  fetcher: Fetcher;
  /** onEvent 由管线接管（进度 + 日志）；由调用方构建（main 注入真实 orchestrator） */
  createAiService(onEvent: (e: AiEvent) => void): AiService;
  run?: RunHandle;
  now?: () => number;
}

export async function generateChecklist(
  params: GenerateParams,
  deps: PipelineDeps,
  onProgress: (e: ProgressEvent) => void = () => undefined,
  cancel: CancelToken = { cancelled: false }
): Promise<GenerateResult> {
  const now = deps.now ?? Date.now;
  const run = deps.run;
  const throwIfCancelled = (): void => {
    if (cancel.cancelled) {
      run?.log('warn', '失败', '用户取消生成');
      throw new CancelledError();
    }
  };

  /* ---------- 阶段一：搜索官网材料清单（判定 + 抓取 + 解析 + 分类 + 备注） ---------- */
  onProgress({ type: 'phase', phase: 'search', status: 'active' });
  const searchStart = now();

  const checklistType = await deps.fetcher.fetchChecklistType({
    countryPassport: params.country.value,
    provider: params.school === 'undecided' ? 'NotListed' : params.school.key,
    cricosCode: params.school === 'undecided' ? ' ' : params.school.value,
    studentTypeCode: params.studentTypeCode,
  });
  run?.log('info', '判定', `GetStudentDocumentChecklistType → ${checklistType}`);
  throwIfCancelled();

  const page = await deps.fetcher.fetchChecklistPage();
  run?.log('info', '抓取', `GET /visas/web-evidentiary-tool · ${(page.html.length / 1024 / 1024).toFixed(1)} MB · 本机直连`);
  throwIfCancelled();

  const sections = parseChecklist(page.html, checklistType);
  const itemTotal = sections.reduce((n, s) => n + s.items.length, 0);
  run?.log('ok', '解析', `div#${checklistType} → ${sections.length} 章节 · ${itemTotal} 条 · 结构指纹校验通过`);
  throwIfCancelled();

  // 分类（映射优先，AI 兜底走同一 fallback 链）
  const classifierAi = deps.createAiService((e) => {
    const entry = aiEventToLog(e);
    if (entry) run?.log(entry.level, '分类', entry.message);
  });
  const onClassifierEvent = (e: ClassifierEvent): void => {
    const entry = classifierEventToLog(e);
    run?.log(entry.level, entry.stage, entry.message);
  };
  const classified = await classifySections(
    sections.map((s) => s.name),
    {
      classifyWithAi: (name, categories) => classifierAi.classifySection(name, categories),
      onEvent: onClassifierEvent,
    }
  );
  const hits = classified.filter((c) => !c.autoClassified && !c.pendingManual).length;
  run?.log('info', '分类', `确定性映射命中 ${hits}/${sections.length} 章节`);
  throwIfCancelled();

  // 备注（确定性规则引擎——红线 3）
  let warningCount = 0;
  const annotated = sections.map((s) => ({
    section: s,
    items: s.items.map((it) => {
      const notes = annotateItem(it.text, DEFAULT_RULES);
      if (notes.some((n) => n.level === 'warning')) warningCount += 1;
      return { it, notes };
    }),
  }));
  run?.log('ok', '备注', `规则引擎 R1–R3 注入完成（含 ${warningCount} 条 R3 公证翻译警告）`);

  onProgress({
    type: 'phase',
    phase: 'search',
    status: 'done',
    detail: checklistType,
    durationMs: now() - searchStart,
  });
  onProgress({ type: 'summary', checklistType, sections: sections.length, items: itemTotal });
  throwIfCancelled();

  /* ---------- 阶段二：翻译成中文（分批 → n/total 进度；失败保留英文——状态 D） ---------- */
  onProgress({ type: 'phase', phase: 'translate', status: 'active' });
  const translateStart = now();

  const translateAi = deps.createAiService((e) => {
    const entry = aiEventToLog(e);
    if (entry) run?.log(entry.level, '翻译', entry.message);
    if (e.type === 'fallback') {
      onProgress({
        type: 'fallback-note',
        from: e.provider,
        fromModel: e.model,
        to: e.next,
        errorKind: e.errorKind,
      });
    }
    if (e.type === 'attempt') {
      // 尝试开始即上报——首批长请求期间与 fallback 切换后 UI 立即显示当前 provider
      onProgress({ type: 'provider', provider: e.provider, model: e.model });
    }
  });

  const allTexts = annotated.flatMap((a) => a.items.map(({ it }) => it.text));
  const translations: string[] = [];
  let aiMeta: GenerateResult['aiMeta'] = null;
  const aiMetas: GenerateResult['aiMetas'] = [];
  let translationFailed = false;

  for (let offset = 0; offset < allTexts.length; offset += TRANSLATE_BATCH_SIZE) {
    throwIfCancelled();
    const batch = allTexts.slice(offset, offset + TRANSLATE_BATCH_SIZE);
    try {
      const { translations: zh, meta } = await translateAi.translate(batch);
      translations.push(...zh);
      aiMeta = meta;
      // 批间 fallback 时溯源必须完整——按首次使用顺序去重收集（Codex PR#26 P2）
      if (!aiMetas.some((m) => m.provider === meta.provider && m.model === meta.model)) {
        aiMetas.push(meta);
      }
    } catch (e) {
      if (e instanceof AiExhaustedError) {
        // 全部 provider 失败：保留英文清单，分类与备注仍已注入（#13 状态 D / F6）
        translationFailed = true;
        aiMeta = null;
        run?.log('err', '翻译', '全部已启用 provider 均失败——保留英文清单，可稍后单独重试翻译');
        break;
      }
      throw e; // network 等：向上抛给 UI 错误态（#13）
    }
    onProgress({
      type: 'translate-progress',
      done: Math.min(offset + batch.length, allTexts.length),
      total: allTexts.length,
    });
  }

  // 末批在途期间的取消同样生效——不得携带已取消的结果进入 Step 3（Codex PR#26 P2）
  throwIfCancelled();

  if (!translationFailed) {
    run?.log('ok', '翻译', `完成 ${allTexts.length}/${allTexts.length} 条 · 结构化输出等长校验通过`);
  }
  onProgress({
    type: 'phase',
    phase: 'translate',
    status: 'done',
    durationMs: now() - translateStart,
  });

  /* ---------- 组装（七大分类顺序 + 待人工归类殿后；空组省略） ---------- */
  // 防御断言——等长不变量若被别处破坏，宁可失败也不产出静默 undefined 译文（Kimi minor）
  if (!translationFailed && translations.length !== allTexts.length) {
    throw new Error(`译文与条目数不一致：${translations.length}/${allTexts.length}`);
  }
  let cursor = 0;
  const sectionResults: Array<{ category: string; section: ResultSection }> = annotated.map(
    (a, idx) => {
      const cls = classified[idx];
      const items: ResultItem[] = a.items.map(({ it, notes }) => {
        const zh = translationFailed ? undefined : translations[cursor];
        cursor += 1;
        return { en: it.text, zh, links: it.links, notes };
      });
      return {
        category: cls.category,
        section: {
          name: a.section.name,
          anchorId: a.section.anchorId,
          autoClassified: cls.autoClassified,
          pendingManual: cls.pendingManual,
          items,
        },
      };
    }
  );

  const order: string[] = [...CATEGORIES, PENDING_MANUAL_CATEGORY];
  const groups: ResultGroup[] = order
    .map((category) => ({
      category,
      sections: sectionResults.filter((s) => s.category === category).map((s) => s.section),
    }))
    .filter((g) => g.sections.length > 0);

  return {
    checklistType,
    fetchedAt: page.fetchedAt,
    params,
    groups,
    aiMeta,
    aiMetas,
    translationFailed,
  };
}

/**
 * 状态 D 单独重试翻译（#13）——不重新抓取，仅对既有结果的英文条目重跑翻译链；
 * 成功返回补全译文的新结果（无缝进入完整结果视图）。
 */
export async function retranslateResult(
  result: GenerateResult,
  deps: Pick<PipelineDeps, 'createAiService' | 'run'>,
  onProgress: (e: ProgressEvent) => void = () => undefined
): Promise<GenerateResult> {
  const run = deps.run;
  onProgress({ type: 'phase', phase: 'translate', status: 'active' });
  const translateAi = deps.createAiService((e) => {
    const entry = aiEventToLog(e);
    if (entry) run?.log(entry.level, '翻译', entry.message);
    if (e.type === 'fallback') {
      onProgress({ type: 'fallback-note', from: e.provider, fromModel: e.model, to: e.next, errorKind: e.errorKind });
    }
    if (e.type === 'attempt') {
      onProgress({ type: 'provider', provider: e.provider, model: e.model });
    }
  });

  const allTexts = result.groups.flatMap((g) => g.sections.flatMap((s) => s.items.map((i) => i.en)));
  const translations: string[] = [];
  let aiMeta: GenerateResult['aiMeta'] = null;
  const aiMetas: GenerateResult['aiMetas'] = [];
  for (let offset = 0; offset < allTexts.length; offset += TRANSLATE_BATCH_SIZE) {
    const batch = allTexts.slice(offset, offset + TRANSLATE_BATCH_SIZE);
    const { translations: zh, meta } = await translateAi.translate(batch);
    translations.push(...zh);
    aiMeta = meta;
    if (!aiMetas.some((m) => m.provider === meta.provider && m.model === meta.model)) {
      aiMetas.push(meta);
    }
    onProgress({
      type: 'translate-progress',
      done: Math.min(offset + batch.length, allTexts.length),
      total: allTexts.length,
    });
  }
  run?.log('ok', '翻译', `重试成功 ${allTexts.length}/${allTexts.length} 条`);

  let cursor = 0;
  const groups = result.groups.map((g) => ({
    ...g,
    sections: g.sections.map((s) => ({
      ...s,
      items: s.items.map((item) => {
        const zh = translations[cursor];
        cursor += 1;
        return { ...item, zh };
      }),
    })),
  }));
  return { ...result, groups, aiMeta, aiMetas, translationFailed: false };
}
