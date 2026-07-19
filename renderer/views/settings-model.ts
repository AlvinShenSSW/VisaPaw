/*
 * 设置页纯模型（#12）——拖拽重排、状态 pill、掩码展示、日志行样式。纯函数单测覆盖。
 */

import type { KeyStatus, LogLevel, ProviderId, ProviderSetting, RunSummary } from '../../common/types.ts';

/** 拖拽重排：把 from 位置的 provider 移到 to 位置（越界原样返回） */
export function reorderProviders(
  list: ProviderSetting[],
  from: number,
  to: number
): ProviderSetting[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export type PillState = { text: string; kind: 'ok' | 'warn' | 'off' };

/** 状态 pill：未启用 / 未配置 key / 可用；Keychain 读取异常时全员降级警示 */
export function statusPill(
  setting: ProviderSetting,
  key: KeyStatus | undefined,
  storeError: string | null
): PillState {
  if (!setting.enabled) return { text: '未启用', kind: 'off' };
  if (storeError) return { text: 'Keychain 异常', kind: 'warn' };
  if (!key?.saved) return { text: '未配置 API key', kind: 'warn' };
  return { text: '可用', kind: 'ok' };
}

/** 掩码展示——静态占位点，不由 key 本体派生（#12 决议）；prefix 为厂商前缀或 null */
export function maskDisplay(key: KeyStatus | undefined): string {
  if (!key?.saved) return '';
  return `${key.prefix ?? ''}••••••••••••••••••••`;
}

const PROVIDER_META: Record<
  ProviderId,
  { name: string; small: string; logo: string; models: Array<{ value: string; label: string }> }
> = {
  mimo: {
    name: 'MiMo（小米）',
    small: 'OpenAI / Anthropic 双协议兼容 · baseURL 覆写',
    logo: 'M',
    models: [
      { value: 'mimo-v2.5-pro', label: 'mimo-v2.5-pro（1M 上下文 / 128K 输出）' },
      { value: 'mimo-v2.5', label: 'mimo-v2.5' },
    ],
  },
  deepseek: {
    name: 'DeepSeek（深度求索）',
    small: 'OpenAI 兼容端点 · response_format: json_object',
    logo: 'D',
    models: [
      { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash（默认）' },
      { value: 'deepseek-chat', label: 'deepseek-chat' },
    ],
  },
  claude: {
    name: 'Claude（Anthropic）',
    small: '官方 SDK @anthropic-ai/sdk · 结构化输出 + prompt caching',
    logo: 'A',
    models: [
      { value: 'claude-opus-4-8', label: 'claude-opus-4-8（$5 / $25 每 MTok · 单次约 $0.3）' },
      {
        value: 'claude-sonnet-5',
        label: 'claude-sonnet-5（$3 / $15 · 2026-08-31 前 $2/$10 · 单次约 $0.1）',
      },
    ],
  },
  openai: {
    name: 'ChatGPT（OpenAI）',
    small: '官方 SDK openai · response_format: json_schema',
    logo: 'G',
    models: [{ value: '', label: '默认取当期旗舰（gpt-5.2，可改）' }],
  },
};

export function providerMeta(id: ProviderId): (typeof PROVIDER_META)[ProviderId] {
  return PROVIDER_META[id];
}

/** 日志运行下拉选项标签：`2026-07-19 14:32 · Streamlined · 成功` */
export function runOptionLabel(run: RunSummary): string {
  const d = new Date(run.startedAt);
  const p = (n: number): string => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  const type = run.checklistType ? ` · ${run.checklistType}` : '';
  const status =
    run.status === 'success'
      ? run.translationFailed
        ? '成功（翻译降级）'
        : '成功'
      : run.status === 'error'
        ? '失败'
        : '进行中';
  return `${ts}${type} · ${status}`;
}

export function levelClass(level: LogLevel): string {
  return `k-${level}`;
}

/** 日志时间列：HH:mm:ss.SSS（mockups/04 逐条毫秒时间戳） */
export function clock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
