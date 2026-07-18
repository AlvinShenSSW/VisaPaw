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

/* ------------------------------ 生成管线（#10/#11/#16） ------------------------------ */

export type ChecklistTypeName = 'Regular' | 'Streamlined' | 'Undetermined';

export interface GenerateParams {
  country: TermItem;
  school: TermItem | 'undecided';
  studentTypeCode: string;
}

/** Step 2 轻量两阶段进度事件（细粒度过程写日志，不在 UI 展开——SPEC §4 修订） */
export type ProgressEvent =
  | { type: 'phase'; phase: 'search' | 'translate'; status: 'active' | 'done'; detail?: string; durationMs?: number }
  | { type: 'summary'; checklistType: ChecklistTypeName; sections: number; items: number }
  | { type: 'provider'; provider: ProviderId; model: string }
  | {
      type: 'fallback-note';
      from: ProviderId;
      fromModel: string;
      to?: ProviderId;
      errorKind: string;
    }
  | { type: 'translate-progress'; done: number; total: number };

export interface ResultNote {
  ruleId: string;
  note: string;
  level: 'normal' | 'warning';
}

export interface ResultItem {
  /** 官网英文原文 */
  en: string;
  /** 中文译文；全部 provider 失败时缺省（#13 状态 D） */
  zh?: string;
  links: Array<{ text: string; href: string }>;
  notes: ResultNote[];
}

export interface ResultSection {
  name: string;
  anchorId: string | null;
  autoClassified: boolean;
  pendingManual: boolean;
  items: ResultItem[];
}

export interface ResultGroup {
  category: string;
  sections: ResultSection[];
}

export interface GenerateResult {
  checklistType: ChecklistTypeName;
  /** UTC ISO 抓取时间（红线三要素之一） */
  fetchedAt: string;
  params: GenerateParams;
  groups: ResultGroup[];
  /** 最终批次使用的 provider/模型；翻译整体失败时为 null */
  aiMeta: { provider: ProviderId; model: string } | null;
  /** 全程参与翻译的 provider（按首次使用顺序去重）——批间 fallback 时溯源完整（红线 5） */
  aiMetas: Array<{ provider: ProviderId; model: string }>;
  /** true = 保留英文清单（全部 provider 失败，#13 状态 D） */
  translationFailed: boolean;
}

export interface VisapawBridge {
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  setProviderKey(provider: ProviderId, key: string): Promise<VaultStatus>;
  deleteProviderKey(provider: ProviderId): Promise<VaultStatus>;
  getProviderKeyStatus(): Promise<VaultStatus>;
  getSystemStatus(): Promise<{ dark: boolean; version: string }>;
  /** Termstore 下拉数据（main 侧 7 天缓存；smoke 模式返回空） */
  getTerms(kind: TermKind): Promise<TermItem[]>;
  /** 启动生成（进度经 onGenerateProgress 流式推送；resolve 为最终结果或抛错） */
  startGenerate(params: GenerateParams): Promise<GenerateResult>;
  cancelGenerate(): Promise<void>;
  /** 订阅进度事件；返回退订函数 */
  onGenerateProgress(cb: (e: ProgressEvent) => void): () => void;
  listRunLogs(): Promise<RunSummary[]>;
  getRunLog(id: string): Promise<RunLog | null>;
  /** 导出为文本（#12「导出日志」——渲染层负责落盘对话框） */
  exportRunLog(id: string): Promise<string | null>;
  clearRunLogs(): Promise<void>;
}
