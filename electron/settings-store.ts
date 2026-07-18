/*
 * 本地应用设置（provider 顺序/启用/模型、学生类型默认值），userData/settings.json。
 * 复用 BookingPro 的 sanitize + patch 合并模式；纯函数与文件 IO 分离以便单测。
 * 不含任何个人信息（AGENTS 红线 2）。
 */

import fs from 'node:fs';
import path from 'node:path';

export const PROVIDER_IDS = ['claude', 'openai', 'mimo'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderSetting {
  id: ProviderId;
  enabled: boolean;
  model: string;
}

export interface Settings {
  /** 数组顺序即 fallback 顺序（#12 拖拽排序持久化于此） */
  providers: ProviderSetting[];
  /** 学生类型默认值：'01'–'05'（SPEC §3） */
  studentTypeDefault: string;
}

export type SettingsPatch = Partial<Settings>;

export const DEFAULT_SETTINGS: Settings = {
  providers: [
    { id: 'claude', enabled: false, model: 'claude-opus-4-8' },
    { id: 'openai', enabled: false, model: '' },
    { id: 'mimo', enabled: false, model: 'mimo-v2.5-pro' },
  ],
  studentTypeDefault: '01',
};

const isProviderId = (v: unknown): v is ProviderId =>
  typeof v === 'string' && (PROVIDER_IDS as readonly string[]).includes(v);

/** 只接受已知字段与正确类型；renderer 可信但畸形载荷不得污染存储。 */
export function sanitizeSettings(input: unknown): SettingsPatch {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: SettingsPatch = {};
  if (Array.isArray(i.providers)) {
    const seen = new Set<ProviderId>();
    const providers: ProviderSetting[] = [];
    for (const raw of i.providers as unknown[]) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      if (!isProviderId(r.id) || seen.has(r.id)) continue;
      seen.add(r.id);
      providers.push({
        id: r.id,
        enabled: r.enabled === true,
        model: typeof r.model === 'string' ? r.model : '',
      });
    }
    if (providers.length > 0) out.providers = providers;
  }
  if (typeof i.studentTypeDefault === 'string' && /^0[1-5]$/.test(i.studentTypeDefault)) {
    out.studentTypeDefault = i.studentTypeDefault;
  }
  return out;
}

export interface SettingsStore {
  get(): Settings;
  /** patch 已过 sanitize 后浅合并并原子落盘，返回合并结果 */
  set(patch: unknown): Settings;
}

export function createSettingsStore(filePath: string): SettingsStore {
  function read(): Settings {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
      const patch = sanitizeSettings(raw);
      return { ...DEFAULT_SETTINGS, ...patch };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }
  function write(next: Settings): void {
    const tmp = `${filePath}.tmp`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, filePath);
  }
  return {
    get: read,
    set(patch: unknown): Settings {
      const next = { ...read(), ...sanitizeSettings(patch) };
      write(next);
      return next;
    },
  };
}
