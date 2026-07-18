import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { displayValue, filterOptions, moveActive } from '../renderer/lib/combobox.ts';
import { providerChainLabel } from '../renderer/lib/status.ts';

const cricos = (
  JSON.parse(readFileSync(join(process.cwd(), 'tests', 'fixtures', 'termstore-cricos.json'), 'utf8')) as {
    d: { data: Array<{ Key: string; Value: string }> };
  }
).d.data.map((x) => ({ key: x.Key, value: x.Value }));

describe('filterOptions（纯本地模糊过滤——issue 验收：无网络）', () => {
  it('名称大小写不敏感子串命中并给出高亮分段（mockup「melb」示例）', () => {
    const out = filterOptions(cricos, 'melb');
    expect(out.length).toBeGreaterThanOrEqual(3);
    const uni = out.find((o) => o.option.value === '00116K')!;
    expect(uni.option.key).toContain('Melbourne');
    const hitSeg = uni.segments.find((s) => s.hit)!;
    expect(hitSeg.text.toLowerCase()).toBe('melb');
    expect(uni.segments.map((s) => s.text).join('')).toBe(uni.option.key);
  });

  it('CRICOS 码命中（直接输入代码）', () => {
    const out = filterOptions(cricos, '00116K');
    expect(out.some((o) => o.option.value === '00116K')).toBe(true);
  });

  it('空查询返回前 limit 项；limit 生效', () => {
    expect(filterOptions(cricos, '', 10)).toHaveLength(10);
    expect(filterOptions(cricos, 'a', 5)).toHaveLength(5);
  });

  it('无命中返回空数组', () => {
    expect(filterOptions(cricos, 'zzz-not-a-school-zzz')).toHaveLength(0);
  });
});

describe('moveActive（↑↓ 循环含固定尾项）', () => {
  it('向下从 -1 → 0，末位回绕到 0；向上从 -1 → 末位', () => {
    expect(moveActive(-1, 1, 4)).toBe(0);
    expect(moveActive(3, 1, 4)).toBe(0);
    expect(moveActive(-1, -1, 4)).toBe(3);
    expect(moveActive(0, -1, 4)).toBe(3);
  });
  it('空列表恒为 -1', () => {
    expect(moveActive(-1, 1, 0)).toBe(-1);
  });
});

describe('displayValue 与 provider 链文案', () => {
  it('选中项显示「名称（代码）」；未定显示未定文案', () => {
    expect(displayValue({ key: 'China', value: 'CHN' }, '未定')).toBe('China（CHN）');
    expect(displayValue('undecided', '未定（尚未确定院校）')).toBe('未定（尚未确定院校）');
    expect(displayValue(null, '未定')).toBe('');
  });

  it('provider 链取自 settings 实际启用与排序（#9 决议）', () => {
    expect(
      providerChainLabel([
        { id: 'claude', enabled: true, model: 'claude-opus-4-8' },
        { id: 'openai', enabled: true, model: '' },
        { id: 'mimo', enabled: true, model: 'mimo-v2.5-pro' },
      ])
    ).toBe('AI Provider：Claude · claude-opus-4-8（fallback：ChatGPT → MiMo）');
    expect(
      providerChainLabel([
        { id: 'mimo', enabled: true, model: 'mimo-v2.5-pro' },
        { id: 'claude', enabled: false, model: '' },
        { id: 'openai', enabled: false, model: '' },
      ])
    ).toBe('AI Provider：MiMo · mimo-v2.5-pro');
    expect(providerChainLabel([{ id: 'claude', enabled: false, model: '' }])).toContain('未配置');
  });
});
