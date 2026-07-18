/*
 * 导出器（#14）——Markdown / 打印 HTML（printToPDF 模板）/ 剪贴板双格式。
 * 与结果视图共用 common/result-view 的展示构建（逐条一致由构造保证）。
 * 红线：三要素（抓取时间/清单类型/免责声明）+ 实际 provider + 自动归类标注
 * 在任何导出物中不可省略。
 */

import type { GenerateResult } from '../common/types.ts';
import { aiMetaLabel, buildDisplayGroups, cnIndex, formatFetchedAt } from '../common/result-view.ts';

export const DISCLAIMER =
  '免责声明：本清单由官网 Document Checklist Tool 自动生成并翻译，仅供参考，不构成移民建议，请以 immi.homeaffairs.gov.au 官网为准。';

const TITLE = '澳大利亚学生签证（Subclass 500）申请材料清单';

function metaLine(result: GenerateResult): string {
  const school =
    result.params.school === 'undecided'
      ? '未定'
      : `${result.params.school.key}（CRICOS ${result.params.school.value}）`;
  return [
    `清单类型：${result.checklistType}`,
    `护照国籍：${result.params.country.key}（${result.params.country.value}）`,
    `院校：${school}`,
    `学生类型：${result.params.studentTypeCode}`,
  ].join(' ｜ ');
}

function sourceLine(result: GenerateResult): string {
  return `数据来源：immi.homeaffairs.gov.au Document Checklist Tool ｜ 抓取时间：${formatFetchedAt(result.fetchedAt)} ｜ ${aiMetaLabel(result)}`;
}

const ensurePeriod = (t: string): string => (/[。.!？?]$/.test(t) ? t : `${t}。`);

/** Markdown（SPEC §7 文档结构） */
export function buildMarkdown(result: GenerateResult): string {
  const lines: string[] = [
    `# ${TITLE}`,
    '',
    metaLine(result),
    '',
    sourceLine(result),
    '',
  ];
  for (const [gi, g] of buildDisplayGroups(result).entries()) {
    lines.push(`## ${cnIndex(gi)}、${g.category}`, '');
    for (const row of g.items) {
      const main = row.item.zh ?? row.item.en;
      const tags = [
        row.autoClassified ? '〔✦ 自动归类〕' : '',
        row.pendingManual ? '〔◌ 待人工归类〕' : '',
      ].join('');
      lines.push(`${row.no}. ${main}${tags}`);
      if (row.item.zh !== undefined) {
        lines.push(`   > ${row.sectionName} — ${row.item.en}`);
      }
      for (const n of row.item.notes) {
        lines.push(`   - ${n.level === 'warning' ? '⚠️ ' : ''}备注：${ensurePeriod(n.note.replace(/^⚠️\s*/, ''))}`);
      }
      if (row.autoClassified) {
        lines.push(`   - 备注：本条为官网新增章节，由 AI 兜底归入「${row.autoCategory}」，请人工复核；映射表待更新。`);
      }
      if (row.pendingManual) {
        lines.push('   - 备注：AI 兜底不可用，本章节暂归入「待人工归类」，请人工确认所属分类。');
      }
      lines.push('');
    }
  }
  lines.push('---', '', DISCLAIMER, '');
  return lines.join('\n');
}

/** 纯文本（剪贴板 text/plain） */
export function buildPlainText(result: GenerateResult): string {
  return buildMarkdown(result)
    .replace(/^# /gm, '')
    .replace(/^## /gm, '')
    .replace(/^   > /gm, '   英文原文：')
    .replace(/^---$/gm, '——————————');
}

/** 打印模板（Electron printToPDF）——延续结果页设计语言的浅色打印适配 */
export function buildPrintHtml(result: GenerateResult): string {
  const groups = buildDisplayGroups(result);
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = groups
    .map(
      (g, gi) => `
  <section class="cat">
    <div class="cat-title"><span class="bar"></span><b>${cnIndex(gi)}、${esc(g.category)}</b>
      <span class="en">${esc(g.enSubtitle)}</span><span class="count">${g.itemCount} 项</span></div>
    ${g.items
      .map(
        (row) => `
    <article class="item">
      <div class="line"><span class="no">${row.no}.</span><span class="zh">${esc(row.item.zh ?? row.item.en)}${
        row.autoClassified ? '<span class="tag">✦ 自动归类</span>' : ''
      }${row.pendingManual ? '<span class="tag">◌ 待人工归类</span>' : ''}</span></div>
      ${row.item.zh !== undefined ? `<div class="en-text">${esc(row.sectionName)} — ${esc(row.item.en)}</div>` : ''}
      ${row.item.notes
        .map((n) =>
          n.level === 'warning'
            ? `<div class="note warn">⚠️ ${esc(ensurePeriod(n.note.replace(/^⚠️\s*/, '')))}</div>`
            : `<div class="note">备注：${esc(ensurePeriod(n.note))}</div>`
        )
        .join('')}
      ${row.autoClassified ? `<div class="note">备注：本条为官网新增章节，由 AI 兜底归入「${esc(row.autoCategory)}」，请人工复核；映射表待更新。</div>` : ''}
      ${row.pendingManual ? '<div class="note warn">备注：AI 兜底不可用，本章节暂归入「待人工归类」，请人工确认所属分类。</div>' : ''}
    </article>`
      )
      .join('')}
  </section>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>${TITLE}</title>
<style>
  /* 打印专用浅色模板——延续结果页设计语言（分类色条/备注分层/R3 红条） */
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif; color: #1D2733; padding: 36px 40px; font-size: 12.5px; line-height: 1.65; }
  h1 { font-size: 19px; margin-bottom: 10px; }
  .meta, .src { color: #5A6B7D; font-size: 11.5px; margin-bottom: 4px; }
  .src { margin-bottom: 18px; }
  .cat { margin-bottom: 14px; }
  .cat-title { display: flex; align-items: baseline; gap: 8px; margin: 14px 0 8px; font-size: 14px; }
  .cat-title .bar { width: 4px; height: 12px; background: #2E9BDF; border-radius: 2px; }
  .cat-title .en { color: #8A97A6; font-size: 10.5px; }
  .cat-title .count { margin-left: auto; color: #8A97A6; font-size: 10.5px; }
  .item { border: 1px solid #E1E7EE; border-radius: 8px; padding: 9px 12px; margin-bottom: 8px; break-inside: avoid; page-break-inside: avoid; }
  .line { display: flex; gap: 8px; }
  .no { color: #8A97A6; font-variant-numeric: tabular-nums; }
  .zh { font-weight: 600; }
  .tag { font-size: 10px; color: #1E86C9; border: 1px dashed #BFDFF5; background: #EAF5FD; border-radius: 5px; padding: 0 5px; margin-left: 6px; font-weight: 600; }
  .en-text { margin: 5px 0 0 22px; padding: 6px 9px; border-left: 3px solid #BFDFF5; background: #F5F7FA; color: #5A6B7D; font-size: 11px; border-radius: 0 6px 6px 0; }
  .note { margin: 5px 0 0 22px; border: 1px solid #E1E7EE; background: #F5F7FA; border-radius: 6px; padding: 5px 9px; color: #5A6B7D; font-size: 11px; }
  .note.warn { color: #B23B3B; background: #FBEDED; border: 1px solid #EFC7C7; border-left: 4px solid #B23B3B; font-weight: 500; }
  .disclaimer { margin-top: 20px; padding-top: 12px; border-top: 1px solid #E1E7EE; color: #5A6B7D; font-size: 10.5px; }
</style></head>
<body>
  <h1>${TITLE}</h1>
  <div class="meta">${esc(metaLine(result))}</div>
  <div class="src">${esc(sourceLine(result))}</div>
  ${body}
  <div class="disclaimer">${esc(DISCLAIMER)}</div>
</body></html>`;
}
