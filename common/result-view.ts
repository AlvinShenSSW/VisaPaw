/*
 * Step 3 结果视图纯模型（#11）——展示行扁平化（跨分类连续编号）、
 * 术语高亮分段、抓取时间本地化。纯函数，vitest 直接覆盖。
 */

import type { GenerateResult, ResultItem } from './types.ts';

/** 官方术语（译文括注内高亮为 accent——mockups/03 .term 语义） */
const TERM_RE = /(CoE|OSHC|CRICOS|GS|Form 956A|Form 956|certified translation|AASES)/g;

export interface TermSegment {
  text: string;
  term: boolean;
}

export function termSegments(text: string): TermSegment[] {
  const segs: TermSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(TERM_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) segs.push({ text: text.slice(last, idx), term: false });
    segs.push({ text: m[0], term: true });
    last = idx + m[0].length;
  }
  if (last < text.length) segs.push({ text: text.slice(last), term: false });
  return segs.length > 0 ? segs : [{ text, term: false }];
}

export interface DisplayGroup {
  category: string;
  /** 英文章节副标（该组全部章节名 · 连接） */
  enSubtitle: string;
  itemCount: number;
  items: Array<{
    no: number;
    item: ResultItem;
    sectionName: string;
    anchorId: string | null;
    autoClassified: boolean;
    pendingManual: boolean;
    autoCategory: string;
  }>;
}

/** 结果 → 展示分组（跨分类连续编号，mockups/03 的 1..N） */
export function buildDisplayGroups(result: GenerateResult): DisplayGroup[] {
  let no = 0;
  return result.groups.map((g) => {
    const items = g.sections.flatMap((s) =>
      s.items.map((item) => {
        no += 1;
        return {
          no,
          item,
          sectionName: s.name,
          anchorId: s.anchorId,
          autoClassified: s.autoClassified,
          pendingManual: s.pendingManual,
          autoCategory: g.category,
        };
      })
    );
    return {
      category: g.category,
      enSubtitle: g.sections.map((s) => s.name).join(' · '),
      itemCount: items.length,
      items,
    };
  });
}

/** 中文序号（一、二、…）——mockups/03 分类标题 */
const CN_NUMS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
export function cnIndex(i: number): string {
  return CN_NUMS[i] ?? String(i + 1);
}

/**
 * 抓取时间：内部 UTC ISO → 本地带偏移展示（PR #17 决议：如 `2026-07-19 14:32 +10:00`）。
 * tzOffsetMinutes 注入以便测试；缺省取运行环境。
 */
export function formatFetchedAt(iso: string, tzOffsetMinutes?: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const offset = tzOffsetMinutes ?? -d.getTimezoneOffset();
  const local = new Date(d.getTime() + offset * 60_000);
  const p = (n: number): string => String(n).padStart(2, '0');
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())} ` +
    `${p(local.getUTCHours())}:${p(local.getUTCMinutes())} ` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

/** 翻译元信息行（红线 5：实际 provider；批间 fallback 时列全）*/
export function aiMetaLabel(result: GenerateResult): string {
  const LABEL: Record<string, string> = { claude: 'Claude', openai: 'ChatGPT', mimo: 'MiMo' };
  if (result.translationFailed || !result.aiMeta) {
    return '翻译：暂不可用（保留英文原文，可重试翻译）';
  }
  const main = `${LABEL[result.aiMeta.provider] ?? result.aiMeta.provider} · ${result.aiMeta.model}`;
  if (result.aiMetas.length > 1) {
    const all = result.aiMetas.map((m) => LABEL[m.provider] ?? m.provider).join(' → ');
    return `翻译：${main}（多 provider 参与：${all} · 详见 设置 → 日志）`;
  }
  return `翻译：${main}`;
}
