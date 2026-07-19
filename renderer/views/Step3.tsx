/*
 * Step 3 结果视图（#11，核心页）——严格按 mockups/03：
 * 标题（本地拼接不含姓名）、元信息（三要素 + provider）、七大分类分组（色条+英文副标+条数）、
 * 条目中文主行（术语高亮）、英文原文逐条折叠 + 全局开关、备注分层、自动归类/待人工标注、
 * 底部固定 dock（免责声明 + 三导出）。
 */

import { Fragment } from 'react';
import type { GenerateResult } from '../../common/types.ts';
import { STUDENT_TYPES } from './Step1.tsx';
import {
  GENERAL_NOTES_HEADING,
  aiMetaLabel,
  buildDisplayGroups,
  cnIndex,
  formatFetchedAt,
  termSegments,
} from './step3-model.ts';

export interface Step3Props {
  result: GenerateResult;
  /** 全局英文展开态由 App 持有（标题栏按钮切换） */
  allOpen: boolean;
  onExport(kind: 'markdown' | 'pdf' | 'copy'): void;
  /** 状态 D：单独重试翻译（不重新抓取，#13） */
  onRetryTranslation(): void;
  retryingTranslation?: boolean;
  /** 上次重试失败的原因——不得静默（Codex PR#29 P2） */
  retryError?: string | null;
  /** 导出失败提示——不得只进控制台（Codex PR#30 P2） */
  exportError?: string | null;
}

function Highlight({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {termSegments(text).map((s, i) =>
        s.term ? (
          <span key={i} className="term">
            {s.text}
          </span>
        ) : (
          <Fragment key={i}>{s.text}</Fragment>
        )
      )}
    </>
  );
}

const ensurePeriod = (t: string): string => (/[。.!？?]$/.test(t) ? t : `${t}。`);

export function Step3(props: Step3Props): React.JSX.Element {
  const { result } = props;
  const groups = buildDisplayGroups(result);
  const studentLabel =
    STUDENT_TYPES.find(([c]) => c === result.params.studentTypeCode)?.[1].split(' — ')[0] ??
    result.params.studentTypeCode;

  return (
    <>
      <div className="doc">
        <div className="doc-head">
          <div className="step-label">STEP 3 / 3 · 查看结果</div>
          <h1>澳大利亚学生签证（Subclass 500）申请材料清单</h1>
          <div className="meta">
            <span className="badge-type">{result.checklistType} 清单</span>
            <span>
              护照国籍：
              <b>
                {result.params.country.key}（{result.params.country.value}）
              </b>
            </span>
            <span>
              院校：
              <b>
                {result.params.school === 'undecided'
                  ? '未定'
                  : `${result.params.school.key}（CRICOS ${result.params.school.value}）`}
              </b>
            </span>
            <span>
              学生类型：
              <b>
                {studentLabel}（{result.params.studentTypeCode}）
              </b>
            </span>
          </div>
          <div className="meta-src">
            <span>数据来源：immi.homeaffairs.gov.au — Document Checklist Tool</span>
            <span>抓取时间：{formatFetchedAt(result.fetchedAt)}</span>
            <span className="ai">{aiMetaLabel(result)}</span>
          </div>
          {result.generalNotes.length > 0 && (
            <div className="general-notes">
              <b>{GENERAL_NOTES_HEADING}：</b>
              <ul>
                {result.generalNotes.map((n) => (
                  <li key={n.note} className={n.level === 'warning' ? 'warn' : undefined}>
                    {n.level === 'warning' ? '⚠️ ' : ''}
                    {ensurePeriod(n.note)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {result.translationFailed && (
          <div className="trans-banner">
            <span>🌐</span>
            <span className="grow">
              <b>翻译暂不可用。</b>
              已启用的 provider 均调用失败（失败详情见 设置 →
              日志），以下展示官网英文原文；分类与合规备注不依赖 AI，仍已注入。可稍后单独重试翻译，无需重新抓取。
            </span>
            <button
              className="bar-btn"
              onClick={props.onRetryTranslation}
              disabled={props.retryingTranslation}
            >
              {props.retryingTranslation ? '重试中…' : '重试翻译'}
            </button>
          </div>
        )}
        {result.translationFailed && props.retryError && (
          <div className="trans-banner">
            <span>⚠️</span>
            <span className="grow">重试翻译失败：{props.retryError}（英文清单已保留，可稍后再试）</span>
          </div>
        )}
        {groups.map((g, gi) => (
          <div className="cat" key={g.category}>
            <div className="cat-title">
              <span className="zh">
                {cnIndex(gi)}、{g.category}
              </span>
              <span className="en">{g.enSubtitle}</span>
              <span className="count">{g.itemCount} 项</span>
            </div>
            {g.items.map((row) => {
              const mainText = row.item.zh ?? row.item.en;
              const srcHref =
                row.item.links[0]?.href ??
                `https://immi.homeaffairs.gov.au/visas/web-evidentiary-tool${row.anchorId ? `#${row.anchorId}` : ''}`;
              return (
                <div className="item" key={row.no}>
                  <div className="item-line">
                    <span className="item-no">{row.no}.</span>
                    <span className="item-zh">
                      <Highlight text={mainText} />
                      {row.autoClassified && <span className="auto-tag">✦ 自动归类</span>}
                      {row.pendingManual && <span className="auto-tag">◌ 待人工归类</span>}
                    </span>
                  </div>
                  {row.item.zh !== undefined && (
                    // 非受控 details + allOpen 变更时以 key 重挂载重置——React 对受控
                    // <details> 支持不完整，受控写法会与浏览器 toggle 态失步（Kimi PR#27 P2）
                    <details
                      className="en-orig"
                      key={`${row.no}-${props.allOpen}`}
                      {...(props.allOpen ? { open: true } : {})}
                    >
                      <summary>英文原文</summary>
                      <div className="en-text">
                        {row.sectionName} — {row.item.en}{' '}
                        <a
                          className="src-link"
                          href={srcHref}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          官网原文 ↗
                        </a>
                      </div>
                    </details>
                  )}
                  <div className="notes">
                    {row.item.notes.map((n) =>
                      n.level === 'warning' ? (
                        <div className="note-warn" key={n.ruleId}>
                          {ensurePeriod(n.note.replace(/^⚠️\s*/, ''))}
                        </div>
                      ) : (
                        <div className="note" key={n.ruleId}>
                          {ensurePeriod(n.note)}
                        </div>
                      )
                    )}
                    {row.autoClassified && (
                      <div className="note">
                        本条为官网新增章节，由 AI 兜底归入「{row.autoCategory}」，请人工复核；映射表待更新。
                      </div>
                    )}
                    {row.pendingManual && (
                      <div className="note-warn">
                        AI 兜底不可用，本章节暂归入「待人工归类」，请人工确认所属分类。
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {props.exportError && (
        <div className="trans-banner" style={{ margin: '10px 24px 0' }}>
          <span>⚠️</span>
          <span className="grow">导出失败：{props.exportError}</span>
        </div>
      )}
      <div className="dock">
        <div className="disclaimer">
          <b>免责声明：</b>
          本清单由官网 Document Checklist Tool 自动生成并翻译，仅供参考，不构成移民建议，请以
          immi.homeaffairs.gov.au 官网为准。
        </div>
        <div className="actions">
          <button className="btn" onClick={() => props.onExport('markdown')}>
            ⬇ 导出 Markdown
          </button>
          <button className="btn" onClick={() => props.onExport('pdf')}>
            ⬇ 导出 PDF
          </button>
          <button className="btn btn-primary" onClick={() => props.onExport('copy')}>
            ⧉ 复制到剪贴板
          </button>
        </div>
      </div>
    </>
  );
}
