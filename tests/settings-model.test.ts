import { describe, it, expect } from 'vitest';
import {
  clock,
  levelClass,
  maskDisplay,
  providerMeta,
  reorderProviders,
  runOptionLabel,
  statusPill,
} from '../renderer/views/settings-model.ts';
import type { ProviderSetting } from '../common/types.ts';

const P = (id: 'claude' | 'openai' | 'mimo'): ProviderSetting => ({ id, enabled: true, model: '' });

describe('reorderProviders（拖拽 = fallback 顺序）', () => {
  it('前移/后移/越界', () => {
    const list = [P('claude'), P('openai'), P('mimo')];
    expect(reorderProviders(list, 2, 0).map((p) => p.id)).toEqual(['mimo', 'claude', 'openai']);
    expect(reorderProviders(list, 0, 2).map((p) => p.id)).toEqual(['openai', 'mimo', 'claude']);
    expect(reorderProviders(list, 0, 0)).toBe(list);
    expect(reorderProviders(list, 5, 0)).toBe(list);
  });
});

describe('statusPill（可用/未配置/未启用/Keychain 异常）', () => {
  it('四态判定', () => {
    expect(statusPill({ ...P('claude'), enabled: false }, { saved: true, prefix: 'sk-ant-…' }, null)).toEqual({
      text: '未启用',
      kind: 'off',
    });
    expect(statusPill(P('claude'), { saved: false, prefix: null }, null)).toEqual({
      text: '未配置 API key',
      kind: 'warn',
    });
    expect(statusPill(P('claude'), { saved: true, prefix: 'sk-ant-…' }, null)).toEqual({
      text: '可用',
      kind: 'ok',
    });
    expect(statusPill(P('claude'), { saved: true, prefix: null }, '解密失败').kind).toBe('warn');
  });
});

describe('maskDisplay（#12 决议：静态占位，不由 key 派生）', () => {
  it('前缀 + 定长点；未保存为空', () => {
    expect(maskDisplay({ saved: true, prefix: 'sk-ant-…' })).toBe('sk-ant-…••••••••••••••••••••');
    expect(maskDisplay({ saved: true, prefix: null })).toBe('••••••••••••••••••••');
    expect(maskDisplay({ saved: false, prefix: null })).toBe('');
    expect(maskDisplay(undefined)).toBe('');
  });
});

describe('runOptionLabel / levelClass / clock / providerMeta', () => {
  it('运行下拉标签三态', () => {
    const base = {
      id: 'run-1',
      startedAt: new Date(2026, 6, 19, 14, 32).getTime(),
      params: { country: 'CHN', cricosCode: '00116K', studentTypeCode: '01' },
    };
    expect(runOptionLabel({ ...base, status: 'success', checklistType: 'Streamlined' })).toBe(
      '2026-07-19 14:32 · Streamlined · 成功'
    );
    expect(
      runOptionLabel({ ...base, status: 'success', checklistType: 'Streamlined', translationFailed: true })
    ).toContain('翻译降级');
    expect(runOptionLabel({ ...base, status: 'error' })).toContain('失败');
  });

  it('级别样式类与毫秒时间戳', () => {
    expect(levelClass('warn')).toBe('k-warn');
    expect(clock(new Date(2026, 6, 19, 14, 31, 37, 102).getTime())).toBe('14:31:37.102');
  });

  it('三家元数据齐备（名称/描述/模型）', () => {
    for (const id of ['claude', 'openai', 'mimo'] as const) {
      const m = providerMeta(id);
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.models.length).toBeGreaterThan(0);
    }
    expect(providerMeta('claude').models.map((m) => m.value)).toEqual([
      'claude-opus-4-8',
      'claude-sonnet-5',
    ]);
  });
});
