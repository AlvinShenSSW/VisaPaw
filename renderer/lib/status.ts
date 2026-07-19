/*
 * 状态栏 provider 链文案（#9 决议：取自 settings 实际启用与排序，mockup 顺序仅示例态）。
 */

import type { ProviderSetting } from '../../common/types.ts';

const LABEL: Record<string, string> = {
  claude: 'Claude',
  openai: 'ChatGPT',
  mimo: 'MiMo',
  deepseek: 'DeepSeek',
};

export function providerChainLabel(providers: ProviderSetting[]): string {
  const enabled = providers.filter((p) => p.enabled);
  if (enabled.length === 0) return 'AI Provider：未配置（可在设置中添加）';
  const [first, ...rest] = enabled;
  const name = (p: ProviderSetting): string => LABEL[p.id] ?? p.id;
  const head = `${name(first)}${first.model ? ` · ${first.model}` : ''}`;
  return rest.length > 0
    ? `AI Provider：${head}（fallback：${rest.map(name).join(' → ')}）`
    : `AI Provider：${head}`;
}
