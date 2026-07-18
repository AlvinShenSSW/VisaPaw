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

/* ------------------------------ 生成日志（#15） ------------------------------ */

/** 级别与阶段字面量逐字对齐 mockups/04 日志窗口 */
export type LogLevel = 'info' | 'ok' | 'warn' | 'err';
export type LogStage = '判定' | '抓取' | '解析' | '分类' | '备注' | '翻译' | '完成' | '失败';

export interface LogEntry {
  /** epoch ms（展示层转本地毫秒时间戳） */
  ts: number;
  level: LogLevel;
  stage: LogStage;
  message: string;
  durationMs?: number;
}

/** 运行参数摘要——仅官网工具三字段，无任何个人信息（红线 2） */
export interface RunParams {
  country: string;
  cricosCode: string;
  studentTypeCode: string;
}

export interface RunSummary {
  id: string;
  startedAt: number;
  params: RunParams;
  status: 'running' | 'success' | 'error';
  totalMs?: number;
  checklistType?: string;
}

export interface RunLog {
  summary: RunSummary;
  entries: LogEntry[];
}

/* ------------------------------ 官网下拉数据（#4/#9） ------------------------------ */

export interface TermItem {
  /** 名称（国家英文名 / 院校名） */
  key: string;
  /** 代码（国家 ISO3 / 院校 CRICOS 码） */
  value: string;
}

export type TermKind = 'countries' | 'cricos';

export interface VisapawBridge {
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  setProviderKey(provider: ProviderId, key: string): Promise<VaultStatus>;
  deleteProviderKey(provider: ProviderId): Promise<VaultStatus>;
  getProviderKeyStatus(): Promise<VaultStatus>;
  getSystemStatus(): Promise<{ dark: boolean; version: string }>;
  /** Termstore 下拉数据（main 侧 7 天缓存；smoke 模式返回空） */
  getTerms(kind: TermKind): Promise<TermItem[]>;
  listRunLogs(): Promise<RunSummary[]>;
  getRunLog(id: string): Promise<RunLog | null>;
  /** 导出为文本（#12「导出日志」——渲染层负责落盘对话框） */
  exportRunLog(id: string): Promise<string | null>;
  clearRunLogs(): Promise<void>;
}
