import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseChecklist } from '../electron/parser.ts';
import {
  CATEGORIES,
  PENDING_MANUAL_CATEGORY,
  SECTION_CATEGORY_MAP,
  classifySections,
  type ClassifierEvent,
} from '../electron/classifier.ts';

const pageHtml = gunzipSync(
  readFileSync(join(process.cwd(), 'tests', 'fixtures', 'evidentiary-tool.html.gz'))
).toString('utf8');

describe('确定性映射（快照集成：三套清单全覆盖）', () => {
  for (const type of ['Regular', 'Streamlined', 'Undetermined'] as const) {
    it(`${type} 清单全部章节命中映射表——0 未命中、0 AI 调用`, async () => {
      const names = parseChecklist(pageHtml, type).map((s) => s.name);
      const ai = vi.fn();
      const events: ClassifierEvent[] = [];
      const result = await classifySections(names, { classifyWithAi: ai, onEvent: (e) => events.push(e) });
      expect(ai).not.toHaveBeenCalled();
      expect(events).toEqual([]);
      expect(result.every((r) => !r.autoClassified && !r.pendingManual)).toBe(true);
      expect(result.every((r) => (CATEGORIES as readonly string[]).includes(r.category))).toBe(true);
    });
  }

  it('SPEC §5 关键归属抽查（含 Special categories 确定性映射——PR #17 决议）', async () => {
    const result = await classifySections([
      'Identity',
      'Evidence of your identity',
      'Special categories',
      'Evidence of financial capacity',
      'Health insurance',
      'Welfare arrangements for under 18 year old student',
      'Appointment or withdrawal of an authorised recipient - Form 956A',
    ]);
    expect(result.map((r) => r.category)).toEqual([
      '个人身份类',
      '个人身份类',
      '教育与工作背景类',
      '资金财务类',
      '健康与保险类',
      '家庭成员与监护类',
      '代理与授权类',
    ]);
  });

  it('大小写变体（Migration Agent，Streamlined）经归一化命中', async () => {
    const [r] = await classifySections([
      'Migration Agent - Form 956 Advice by a migration agent/exempt person',
    ]);
    expect(r.category).toBe('代理与授权类');
    expect(r.autoClassified).toBe(false);
  });

  it('映射表键本身即快照精确名（逐字对齐断言）', () => {
    const names = new Set(
      (['Regular', 'Streamlined', 'Undetermined'] as const).flatMap((t) =>
        parseChecklist(pageHtml, t).map((s) => s.name)
      )
    );
    // 快照全部章节名（除大小写差异）都在映射键中
    const keys = new Set(Object.keys(SECTION_CATEGORY_MAP).map((k) => k.toLowerCase()));
    for (const n of names) {
      expect(keys.has(n.toLowerCase()), `映射缺失：${n}`).toBe(true);
    }
  });
});

describe('AI 兜底（真正未知的新章节）', () => {
  it('未命中 → mapping-outdated 告警 + AI 兜底成功 → autoClassified: true + meta', async () => {
    const ai = vi.fn().mockResolvedValue({
      category: '品行类',
      meta: { provider: 'claude', model: 'claude-opus-4-8' },
    });
    const events: ClassifierEvent[] = [];
    const [r] = await classifySections(['Character requirements'], {
      classifyWithAi: ai,
      onEvent: (e) => events.push(e),
    });
    expect(ai).toHaveBeenCalledWith('Character requirements', [...CATEGORIES]);
    expect(r).toMatchObject({ category: '品行类', autoClassified: true, pendingManual: false });
    expect(r.aiMeta).toEqual({ provider: 'claude', model: 'claude-opus-4-8' });
    expect(events.map((e) => e.type)).toEqual(['mapping-outdated', 'auto-classified']);
  });

  it('F6：AI 失败 → 待人工归类，不标 autoClassified，主流程不阻断', async () => {
    const ai = vi.fn().mockRejectedValue(new Error('全部 provider 失败'));
    const events: ClassifierEvent[] = [];
    const [r] = await classifySections(['Brand new section'], {
      classifyWithAi: ai,
      onEvent: (e) => events.push(e),
    });
    expect(r).toMatchObject({
      category: PENDING_MANUAL_CATEGORY,
      autoClassified: false,
      pendingManual: true,
    });
    expect(events.map((e) => e.type)).toEqual(['mapping-outdated', 'manual-pending']);
  });

  it('F6：无可用 AI（未注入）→ 直接待人工归类，仍发映射告警', async () => {
    const events: ClassifierEvent[] = [];
    const [r] = await classifySections(['Brand new section'], { onEvent: (e) => events.push(e) });
    expect(r.category).toBe(PENDING_MANUAL_CATEGORY);
    expect(events.map((e) => e.type)).toEqual(['mapping-outdated', 'manual-pending']);
  });

  it('混合场景：命中章节不受未知章节影响，顺序保持', async () => {
    const ai = vi.fn().mockResolvedValue({
      category: '教育与工作背景类',
      meta: { provider: 'mimo', model: 'mimo-v2.5-pro' },
    });
    const result = await classifySections(['Identity', 'New thing', 'Health insurance'], {
      classifyWithAi: ai,
    });
    expect(result.map((r) => [r.name, r.category, r.autoClassified])).toEqual([
      ['Identity', '个人身份类', false],
      ['New thing', '教育与工作背景类', true],
      ['Health insurance', '健康与保险类', false],
    ]);
  });
});
