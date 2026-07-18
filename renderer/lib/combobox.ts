/*
 * Combobox 纯逻辑（#9）——本地模糊过滤、匹配段高亮、键盘活动项移动。
 * 纯函数无 DOM 依赖，vitest 直接覆盖；组件只做接线。
 */

import type { TermItem } from '../../common/types.ts';

export interface MatchSegment {
  text: string;
  hit: boolean;
}

export interface FilteredOption {
  option: TermItem;
  /** key 的高亮分段（首个命中段标 hit；无命中则整段普通） */
  segments: MatchSegment[];
}

/** 本地模糊过滤：大小写不敏感子串，命中名称或代码；纯本地，无网络（issue 验收） */
export function filterOptions(options: TermItem[], query: string, limit = 50): FilteredOption[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return options.slice(0, limit).map((option) => ({ option, segments: plain(option.key) }));
  }
  const out: FilteredOption[] = [];
  for (const option of options) {
    const keyIdx = option.key.toLowerCase().indexOf(q);
    const codeHit = option.value.toLowerCase().includes(q);
    if (keyIdx < 0 && !codeHit) continue;
    out.push({ option, segments: keyIdx >= 0 ? split(option.key, keyIdx, q.length) : plain(option.key) });
    if (out.length >= limit) break;
  }
  return out;
}

function plain(text: string): MatchSegment[] {
  return text ? [{ text, hit: false }] : [];
}

function split(text: string, start: number, len: number): MatchSegment[] {
  const segs: MatchSegment[] = [];
  if (start > 0) segs.push({ text: text.slice(0, start), hit: false });
  segs.push({ text: text.slice(start, start + len), hit: true });
  if (start + len < text.length) segs.push({ text: text.slice(start + len), hit: false });
  return segs;
}

/** ↑↓ 循环移动活动项（count 含固定尾项如「未定」；count=0 → -1） */
export function moveActive(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}

/** 选中值的输入框显示文本（如 `China（CHN）` / `The University of Melbourne（00116K）`） */
export function displayValue(selected: TermItem | 'undecided' | null, undecidedLabel: string): string {
  if (selected === null) return '';
  if (selected === 'undecided') return undecidedLabel;
  return `${selected.key}（${selected.value}）`;
}
