import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  createSettingsStore,
} from '../electron/settings-store.ts';

describe('sanitizeSettings', () => {
  it('拒绝未知 provider id 并保持数组顺序（顺序 = fallback 顺序）', () => {
    const patch = sanitizeSettings({
      providers: [
        { id: 'mimo', enabled: true, model: 'mimo-v2.5-pro' },
        { id: 'bogus', enabled: true, model: 'x' },
        { id: 'claude', enabled: false, model: 'claude-opus-4-8' },
      ],
    });
    expect(patch.providers?.map((p) => p.id)).toEqual(['mimo', 'claude']);
    expect(patch.providers?.[0].enabled).toBe(true);
  });

  it('去重同一 provider（保留首个）', () => {
    const patch = sanitizeSettings({
      providers: [
        { id: 'claude', enabled: true, model: 'a' },
        { id: 'claude', enabled: false, model: 'b' },
      ],
    });
    expect(patch.providers).toHaveLength(1);
    expect(patch.providers?.[0].model).toBe('a');
  });

  it('studentTypeDefault 只接受 01–05', () => {
    expect(sanitizeSettings({ studentTypeDefault: '03' }).studentTypeDefault).toBe('03');
    expect(sanitizeSettings({ studentTypeDefault: '9' }).studentTypeDefault).toBeUndefined();
    expect(sanitizeSettings({ studentTypeDefault: 7 }).studentTypeDefault).toBeUndefined();
  });

  it('恶意/畸形输入不产生字段', () => {
    expect(sanitizeSettings(null)).toEqual({});
    expect(sanitizeSettings({ providers: 'nope', extra: 1 })).toEqual({});
  });
});

describe('createSettingsStore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'visapaw-settings-'));

  it('首读返回默认值；patch 后持久化并保序合并', () => {
    const store = createSettingsStore(join(dir, 'settings.json'));
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    const next = store.set({
      providers: [
        { id: 'mimo', enabled: true, model: 'mimo-v2.5-pro' },
        { id: 'claude', enabled: true, model: 'claude-opus-4-8' },
        { id: 'openai', enabled: false, model: '' },
      ],
    });
    expect(next.providers.map((p) => p.id)).toEqual(['mimo', 'claude', 'openai']);
    // 重新打开 → 读到持久化的顺序
    const reopened = createSettingsStore(join(dir, 'settings.json'));
    expect(reopened.get().providers[0].id).toBe('mimo');
    expect(reopened.get().studentTypeDefault).toBe('01');
  });

  it('部分 providers patch 不丢失固定 provider（Codex 外门 P2）', () => {
    const p = join(dir, 'partial.json');
    const store = createSettingsStore(p);
    store.set({
      providers: [
        { id: 'openai', enabled: true, model: 'x' },
        { id: 'claude', enabled: true, model: 'claude-sonnet-5' },
        { id: 'mimo', enabled: false, model: 'mimo-v2.5' },
      ],
    });
    // patch 只含 mimo（其余畸形被 sanitize 丢弃）→ 现有配置补全，已有 model/enabled 保留
    const next = store.set({
      providers: [{ id: 'mimo', enabled: true, model: 'mimo-v2.5-pro' }, { id: 'bad' }],
    });
    expect(next.providers.map((x) => x.id)).toEqual(['mimo', 'openai', 'claude']);
    expect(next.providers.find((x) => x.id === 'claude')?.model).toBe('claude-sonnet-5');
    expect(createSettingsStore(p).get().providers).toHaveLength(3);
  });

  it('损坏的 settings.json 回退默认值而非崩溃', () => {
    const p = join(dir, 'corrupt.json');
    const store = createSettingsStore(p);
    store.set({ studentTypeDefault: '02' });
    writeFileSync(p, '{not json');
    expect(createSettingsStore(p).get()).toEqual(DEFAULT_SETTINGS);
  });
});
