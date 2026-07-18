import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { CancelledError, generateChecklist, type PipelineDeps } from '../electron/pipeline.ts';
import { AiError, AiExhaustedError } from '../electron/ai/errors.ts';
import type { AiService } from '../electron/ai/orchestrator.ts';
import type { Fetcher } from '../electron/fetcher.ts';
import type { GenerateParams, ProgressEvent } from '../common/types.ts';

const pageHtml = gunzipSync(
  readFileSync(join(process.cwd(), 'tests', 'fixtures', 'evidentiary-tool.html.gz'))
).toString('utf8');

const PARAMS: GenerateParams = {
  country: { key: 'China', value: 'CHN' },
  school: 'undecided',
  studentTypeCode: '01',
};

function stubFetcher(type: 'Regular' | 'Streamlined' | 'Undetermined' = 'Streamlined'): Fetcher {
  return {
    fetchTerms: vi.fn(),
    fetchChecklistType: vi.fn().mockResolvedValue(type),
    fetchChecklistPage: vi
      .fn()
      .mockResolvedValue({ html: pageHtml, fetchedAt: '2026-07-19T06:00:00.000Z' }),
    verifyStructure: () => true,
  } as unknown as Fetcher;
}

/** 逐条回译的假 AI（等长保证）；可注入首批失败等行为 */
function stubAi(behavior?: { failFirstBatch?: AiError; exhaustAll?: boolean }): AiService {
  let batchNo = 0;
  return {
    async translate(items: string[]) {
      batchNo += 1;
      if (behavior?.exhaustAll) throw new AiExhaustedError([]);
      if (behavior?.failFirstBatch && batchNo === 1) throw behavior.failFirstBatch;
      return {
        translations: items.map((t) => `【中文】${t.slice(0, 10)}`),
        meta: { provider: 'claude' as const, model: 'claude-opus-4-8' },
      };
    },
    async classifySection() {
      return { category: '品行类', meta: { provider: 'claude' as const, model: 'claude-opus-4-8' } };
    },
  };
}

function collect(): { events: ProgressEvent[]; onProgress: (e: ProgressEvent) => void } {
  const events: ProgressEvent[] = [];
  return { events, onProgress: (e) => events.push(e) };
}

describe('generateChecklist（正常链路）', () => {
  it('两阶段事件完整、译文按序回填、meta 记录实际 provider、分组按七大分类序', async () => {
    const { events, onProgress } = collect();
    const deps: PipelineDeps = { fetcher: stubFetcher(), createAiService: () => stubAi() };
    const result = await generateChecklist(PARAMS, deps, onProgress);

    expect(result.checklistType).toBe('Streamlined');
    expect(result.fetchedAt).toBe('2026-07-19T06:00:00.000Z');
    expect(result.translationFailed).toBe(false);
    expect(result.aiMeta).toEqual({ provider: 'claude', model: 'claude-opus-4-8' });
    expect(result.aiMetas).toEqual([{ provider: 'claude', model: 'claude-opus-4-8' }]);

    // 阶段事件顺序
    const kinds = events.map((e) => (e.type === 'phase' ? `${e.phase}:${e.status}` : e.type));
    expect(kinds[0]).toBe('search:active');
    expect(kinds).toContain('search:done');
    expect(kinds).toContain('summary');
    expect(kinds).toContain('translate:active');
    expect(kinds.at(-1)).toBe('translate:done');

    // summary 与真实解析一致（Streamlined 13 章节）
    const summary = events.find((e) => e.type === 'summary')!;
    expect(summary).toMatchObject({ checklistType: 'Streamlined', sections: 13 });

    // 译文逐条对应且备注已注入
    const allItems = result.groups.flatMap((g) => g.sections.flatMap((s) => s.items));
    expect(allItems.length).toBeGreaterThan(0);
    for (const item of allItems) {
      expect(item.zh).toContain('【中文】');
      expect(item.notes.some((n) => n.ruleId === 'R1')).toBe(true);
    }
    // 无犯罪条目 R1+R3（若 Streamlined 清单含 police 条目则断言覆盖）
    const police = allItems.filter((i) => /police/i.test(i.en));
    for (const p of police) {
      expect(p.notes.map((n) => n.ruleId)).toEqual(['R1', 'R3']);
    }

    // 分组顺序为七大分类子序
    const order = ['个人身份类', '教育与工作背景类', '资金财务类', '健康与保险类', '品行类', '家庭成员与监护类', '代理与授权类', '待人工归类'];
    const idx = result.groups.map((g) => order.indexOf(g.category));
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it('translate-progress 按批推进到 n/n', async () => {
    const { events, onProgress } = collect();
    await generateChecklist(PARAMS, { fetcher: stubFetcher(), createAiService: () => stubAi() }, onProgress);
    const prog = events.filter((e) => e.type === 'translate-progress');
    expect(prog.length).toBeGreaterThan(1);
    const last = prog.at(-1)!;
    expect(last.done).toBe(last.total);
  });
});

describe('generateChecklist（降级与取消）', () => {
  it('全部 provider 失败 → translationFailed、保留英文、分类与备注仍注入（状态 D / F6）', async () => {
    const result = await generateChecklist(PARAMS, {
      fetcher: stubFetcher(),
      createAiService: () => stubAi({ exhaustAll: true }),
    });
    expect(result.translationFailed).toBe(true);
    expect(result.aiMeta).toBeNull();
    const items = result.groups.flatMap((g) => g.sections.flatMap((s) => s.items));
    expect(items.every((i) => i.zh === undefined)).toBe(true);
    expect(items.every((i) => i.notes.length > 0)).toBe(true);
    expect(result.groups.length).toBeGreaterThan(0);
  });

  it('network 错误向上抛出（不吞）——UI 错误态由 #13 消费', async () => {
    await expect(
      generateChecklist(PARAMS, {
        fetcher: stubFetcher(),
        createAiService: () => stubAi({ failFirstBatch: new AiError('network', '断网', 'claude') }),
      })
    ).rejects.toMatchObject({ kind: 'network' });
  });

  it('取消令牌在批间生效 → CancelledError 且不再调用后续批次', async () => {
    const cancel = { cancelled: false };
    let calls = 0;
    const ai: AiService = {
      async translate(items: string[]) {
        calls += 1;
        cancel.cancelled = true; // 第一批完成后取消
        return {
          translations: items.map(() => '中'),
          meta: { provider: 'claude' as const, model: 'm' },
        };
      },
      async classifySection() {
        return { category: '品行类', meta: { provider: 'claude' as const, model: 'm' } };
      },
    };
    await expect(
      generateChecklist(PARAMS, { fetcher: stubFetcher(), createAiService: () => ai }, undefined, cancel)
    ).rejects.toBeInstanceOf(CancelledError);
    expect(calls).toBe(1);
  });

  it('批间 provider 切换 → aiMetas 溯源完整（Codex PR#26 P2）', async () => {
    let batchNo = 0;
    const ai: AiService = {
      async translate(items: string[]) {
        batchNo += 1;
        const meta =
          batchNo <= 1
            ? { provider: 'mimo' as const, model: 'mimo-v2.5-pro' }
            : { provider: 'claude' as const, model: 'claude-opus-4-8' };
        return { translations: items.map(() => '中'), meta };
      },
      async classifySection() {
        return { category: '品行类', meta: { provider: 'claude' as const, model: 'claude-opus-4-8' } };
      },
    };
    const result = await generateChecklist(PARAMS, { fetcher: stubFetcher(), createAiService: () => ai });
    expect(result.aiMetas).toEqual([
      { provider: 'mimo', model: 'mimo-v2.5-pro' },
      { provider: 'claude', model: 'claude-opus-4-8' },
    ]);
    expect(result.aiMeta).toEqual({ provider: 'claude', model: 'claude-opus-4-8' });
  });

  it('末批在途取消 → 组装前拦截，不返回结果（Codex PR#26 P2）', async () => {
    const cancel = { cancelled: false };
    const total = 34; // Streamlined 条目数超过一批
    void total;
    let call = 0;
    const ai: AiService = {
      async translate(items: string[]) {
        call += 1;
        return { translations: items.map(() => '中'), meta: { provider: 'claude' as const, model: 'm' } };
      },
      async classifySection() {
        return { category: '品行类', meta: { provider: 'claude' as const, model: 'm' } };
      },
    };
    // 在最后一批完成后、组装前取消：用 onProgress 钩子在最后一次 translate-progress 时置位
    const onProgress = (e: ProgressEvent): void => {
      if (e.type === 'translate-progress' && e.done === e.total) cancel.cancelled = true;
    };
    await expect(
      generateChecklist(PARAMS, { fetcher: stubFetcher(), createAiService: () => ai }, onProgress, cancel)
    ).rejects.toBeInstanceOf(CancelledError);
    expect(call).toBeGreaterThan(0);
  });

  it('fallback 事件转为 fallback-note 进度（Step 2 提示条数据源）', async () => {
    const { events, onProgress } = collect();
    const ai: AiService = {
      async translate(items: string[]) {
        return { translations: items.map(() => '中'), meta: { provider: 'claude' as const, model: 'm' } };
      },
      async classifySection() {
        return { category: '品行类', meta: { provider: 'claude' as const, model: 'm' } };
      },
    };
    await generateChecklist(
      PARAMS,
      {
        fetcher: stubFetcher(),
        createAiService: (onEvent) => {
          // 模拟 orchestrator 在翻译期发出 fallback 事件
          setTimeout(() =>
            onEvent({
              type: 'fallback',
              provider: 'mimo',
              model: 'mimo-v2.5-pro',
              errorKind: 'quota',
              message: '额度耗尽',
              next: 'claude',
            })
          );
          return ai;
        },
      },
      onProgress
    );
    // fallback-note 事件已被管线转发（translate 阶段的 createAiService onEvent 接线）
    await new Promise((r) => setTimeout(r, 10));
    const note = events.find((e) => e.type === 'fallback-note');
    expect(note).toMatchObject({ from: 'mimo', to: 'claude', errorKind: 'quota' });
  });
});

describe('reduceProgress（Step 2 视图状态折叠）', () => {
  it('事件序列驱动状态 A → B（含 provider/进度/fallback）', async () => {
    const { reduceProgress } = await import('../renderer/views/step2-state.ts');
    const s = { phase: 'search' as const };
    let state = reduceProgress(s, { type: 'phase', phase: 'search', status: 'active' });
    expect(state.phase).toBe('search');
    state = reduceProgress(state, { type: 'phase', phase: 'search', status: 'done', detail: 'Streamlined', durationMs: 3500 });
    expect(state.phase).toBe('translate');
    expect(state.searchDetail).toBe('Streamlined');
    state = reduceProgress(state, { type: 'summary', checklistType: 'Streamlined', sections: 13, items: 34 });
    state = reduceProgress(state, { type: 'provider', provider: 'claude', model: 'claude-opus-4-8' });
    state = reduceProgress(state, { type: 'translate-progress', done: 21, total: 34 });
    state = reduceProgress(state, {
      type: 'fallback-note',
      from: 'mimo',
      fromModel: 'mimo-v2.5-pro',
      to: 'claude',
      errorKind: 'quota',
    });
    expect(state.summary?.items).toBe(34);
    expect(state.provider?.model).toBe('claude-opus-4-8');
    expect(state.progress).toEqual({ done: 21, total: 34 });
    expect(state.fallback?.errorKind).toBe('quota');
  });
});
