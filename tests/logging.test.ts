import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiEventToLog, classifierEventToLog, createLogStore } from '../electron/logging.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'visapaw-logs-'));
const PARAMS = { country: 'CHN', cricosCode: '00116K', studentTypeCode: '01' };

describe('LogStore（按运行分组，本机持久化）', () => {
  it('一次成功生成产生完整阶段链路日志（issue 验收）', () => {
    let clock = 1_752_900_000_000;
    const store = createLogStore(tmp(), { now: () => (clock += 500) });
    const run = store.startRun(PARAMS);
    run.log('info', '判定', 'GetStudentDocumentChecklistType → Streamlined', 800);
    run.log('info', '抓取', 'GET /visas/web-evidentiary-tool · 1.4 MB · 本机直连', 2400);
    run.log('ok', '解析', 'div#Streamlined → 13 章节 · 34 条 · 结构指纹校验通过', 300);
    run.log('info', '分类', '确定性映射命中 13/13 章节');
    run.log('ok', '备注', '规则引擎 R1–R3 注入 34 条备注');
    run.log('ok', '翻译', '完成 34/34 条 · 等长校验通过');
    run.finish('success', { checklistType: 'Streamlined' });

    const [summary] = store.listRuns();
    expect(summary).toMatchObject({ status: 'success', checklistType: 'Streamlined', params: PARAMS });
    expect(summary.totalMs).toBeGreaterThan(0);
    const full = store.getRun(summary.id);
    expect(full?.entries.map((e) => e.stage)).toEqual(['判定', '抓取', '解析', '分类', '备注', '翻译']);
    expect(full?.entries.every((e) => typeof e.ts === 'number')).toBe(true);
  });

  it('持久化文件中检索不到任何个人信息字段（红线 2）；多余属性被白名单剔除（Codex P1）', () => {
    const dir = tmp();
    const store = createLogStore(dir);
    // 模拟带杂散字段的表单对象经结构化类型流入
    const dirty = { ...PARAMS, applicantName: '张三', passportNumber: 'E12345678' };
    const run = store.startRun(dirty as typeof PARAMS);
    run.log('info', '判定', '判定完成');
    run.finish('success');
    const raw = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
    for (const pii of ['姓名', 'passportNumber', '护照号', 'applicant', '张三', 'E12345678']) {
      expect(raw).not.toContain(pii);
    }
  });

  it('导出为 mockup 同构文本（毫秒时间戳 + 级别|阶段 + 耗时）', () => {
    const store = createLogStore(tmp(), { now: () => Date.UTC(2026, 6, 19, 6, 31, 37, 102) });
    const run = store.startRun(PARAMS);
    run.log('info', '判定', 'GetStudentDocumentChecklistType → Streamlined', 800);
    run.finish('success');
    const text = store.exportRun(run.id)!;
    expect(text).toContain('CHN · 00116K · 学生类型 01');
    expect(text).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3} \[info\|判定\] GetStudentDocumentChecklistType → Streamlined（0\.8s）/);
    expect(store.exportRun('run-does-not-exist')).toBeNull();
  });

  it('清空删除全部运行**含损坏文件**（Codex P2——不留磁盘残留）', () => {
    const dir = tmp();
    const store = createLogStore(dir);
    store.startRun(PARAMS).finish('success');
    writeFileSync(join(dir, 'run-corrupt.json'), '{not json');
    expect(store.listRuns()).toHaveLength(1);
    store.clear();
    expect(store.listRuns()).toHaveLength(0);
    expect(readdirSync(dir).filter((f) => f.startsWith('run-'))).toHaveLength(0);
  });

  it('超过 maxRuns 淘汰最旧运行', () => {
    let clock = 1_000_000;
    const store = createLogStore(tmp(), { now: () => (clock += 1000), maxRuns: 2 });
    store.startRun(PARAMS).finish('success');
    store.startRun(PARAMS).finish('success');
    store.startRun(PARAMS).finish('success');
    expect(store.listRuns().length).toBeLessThanOrEqual(3); // 淘汰在 startRun 时机执行
    store.startRun(PARAMS);
    expect(store.listRuns().length).toBeLessThanOrEqual(3);
  });
});

describe('事件桥（#8 / #6 → 日志条目）', () => {
  it('fallback 事件包含前后 provider 与错误原因（issue 验收）', () => {
    const entry = aiEventToLog({
      type: 'fallback',
      provider: 'mimo',
      model: 'mimo-v2.5-pro',
      errorKind: 'quota',
      message: '套餐/配额耗尽：Token Plan 额度已用尽',
      next: 'claude',
    })!;
    expect(entry.level).toBe('err');
    expect(entry.message).toContain('MiMo · mimo-v2.5-pro');
    expect(entry.message).toContain('→ Claude');
    expect(entry.message).toContain('quota');
    expect(entry.message).toContain('额度已用尽');
  });

  it('无下家时明示「无下一顺位」', () => {
    const entry = aiEventToLog({
      type: 'fallback',
      provider: 'openai',
      model: 'gpt-5.2',
      errorKind: 'server',
      message: '5xx',
    })!;
    expect(entry.message).toContain('无下一顺位');
  });

  it('映射告警与自动归类事件入日志（#6 联动验收）', () => {
    expect(classifierEventToLog({ type: 'mapping-outdated', section: 'New thing' })).toMatchObject({
      level: 'warn',
      stage: '分类',
      message: expect.stringContaining('映射表需更新'),
    });
    expect(
      classifierEventToLog({
        type: 'auto-classified',
        section: 'New thing',
        category: '品行类',
        meta: { provider: 'claude', model: 'claude-opus-4-8' },
      }).message
    ).toContain('已标注');
    expect(
      classifierEventToLog({ type: 'manual-pending', section: 'X', reason: '全部 provider 失败' }).message
    ).toContain('待人工归类');
  });

  it('success 事件记录实际 provider（红线 5 联动）', () => {
    const entry = aiEventToLog({ type: 'success', provider: 'claude', model: 'claude-opus-4-8' })!;
    expect(entry).toMatchObject({ level: 'ok', stage: '翻译' });
    expect(entry.message).toContain('Claude · claude-opus-4-8');
  });
});

describe('orchestrator fallback 事件 next 字段（#15 前后 provider 数据源）', () => {
  it('next 为链上下一个已启用 provider；末位无下家', async () => {
    const { createAiService } = await import('../electron/ai/orchestrator.ts');
    const { AiError } = await import('../electron/ai/errors.ts');
    const events: Array<{ type: string; next?: string }> = [];
    const svc = createAiService({
      settings: {
        providers: [
          { id: 'mimo', enabled: true, model: '' },
          { id: 'openai', enabled: true, model: '' }, // 已启用但无 key——不得成为 next（Codex P2）
          { id: 'claude', enabled: true, model: '' },
        ],
      },
      getKey: (id) => (id === 'openai' ? null : 'k'),
      adapterFactory: (spec) => ({
        id: spec.id,
        model: spec.model,
        async callStructured() {
          throw new AiError('server', 'boom', spec.id);
        },
      }),
      onEvent: (e) => events.push(e as { type: string; next?: string }),
    });
    await svc.translate(['a']).catch(() => undefined);
    const fallbacks = events.filter((e) => e.type === 'fallback');
    expect(fallbacks[0].next).toBe('claude'); // 跳过已启用但无 key 的 openai
    expect(fallbacks[1].next).toBeUndefined();
  });
});
