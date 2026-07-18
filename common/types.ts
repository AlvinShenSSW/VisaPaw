/*
 * renderer 与 main 共享的类型与常量——renderer 只允许从这里 import，
 * 不得触及 electron/ 实现（Kimi 终审 P2：类型解耦）。无任何 Node 依赖。
 */

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

export interface KeyStatus {
  saved: boolean;
  /** 展示用厂商前缀（如 `sk-ant-…`）；无法识别格式时为 null，绝不截取 key 本体 */
  prefix: string | null;
}

export interface VaultStatus {
  providers: Record<ProviderId, KeyStatus>;
  /** 凭据文件存在但无法读取/解密时的错误说明（UI 展示 Keychain 异常，而非误报「未保存」） */
  error: string | null;
}

export interface VisapawBridge {
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  setProviderKey(provider: ProviderId, key: string): Promise<VaultStatus>;
  deleteProviderKey(provider: ProviderId): Promise<VaultStatus>;
  getProviderKeyStatus(): Promise<VaultStatus>;
  getSystemStatus(): Promise<{ dark: boolean; version: string }>;
}
