/*
 * Step 2 生成清单轻量视图（#10）——严格按 mockups/02 两状态：
 * A 搜索官网中（大 spinner + 参数 chip + 两阶段列表）；
 * B 翻译中（provider 标注 + 清单摘要 + n/total 进度条）；fallback 琥珀提示条；
 * 底部「设置 → 日志」链接 + 取消。进度事件经 IPC 流式推送。
 */

import type { ProviderId } from '../../common/types.ts';
import type { Step1Selection } from './Step1.tsx';
import { STUDENT_TYPES } from './Step1.tsx';
import type { Step2State } from './step2-state.ts';

export { reduceProgress, type Step2State } from './step2-state.ts';

const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: 'Claude',
  openai: 'ChatGPT',
  mimo: 'MiMo',
};

export interface Step2Props {
  selection: Step1Selection;
  state: Step2State;
  onCancel(): void;
  onOpenLogs(): void;
  /** 错误态动作：返回表单 / 重试（Codex PR#26 P1——错误后不得困死在 Step 2） */
  onBack(): void;
  onRetry(): void;
}

export function Step2(props: Step2Props): React.JSX.Element {
  const { selection, state } = props;
  const translating = state.phase === 'translate';
  const studentLabel =
    STUDENT_TYPES.find(([code]) => code === selection.studentTypeCode)?.[1].split(' — ')[0] ??
    selection.studentTypeCode;
  const pct =
    state.progress && state.progress.total > 0
      ? Math.round((state.progress.done / state.progress.total) * 100)
      : 0;

  return (
    <div className="content">
      <div className="stepper">
        <div className="sstep done">
          <span className="n">✓</span>填写申请信息
        </div>
        <div className="sline done" />
        <div className="sstep current">
          <span className="n">2</span>生成清单
        </div>
        <div className="sline" />
        <div className="sstep">
          <span className="n">3</span>查看结果
        </div>
      </div>

      <div className="stage">
        <div className="spinner-big" />
        {translating ? (
          <h2>
            正在翻译成中文…
            {state.provider && (
              <span className="provider-tag">
                {PROVIDER_LABEL[state.provider.provider]} · {state.provider.model}
              </span>
            )}
          </h2>
        ) : (
          <h2>正在搜索 Document Checklist Tool…</h2>
        )}
        {translating && state.summary ? (
          <div className="sub">
            已取得 {state.summary.checklistType} 清单（{state.summary.sections} 章节 ·{' '}
            {state.summary.items} 条），正在生成中英双语对照
          </div>
        ) : (
          <div className="sub">根据您的三项选择向移民局官网实时检索材料清单（本机直连）</div>
        )}

        {!translating && (
          <div className="params">
            <span className="pchip">
              护照国籍 <b>{selection.country.key}（{selection.country.value}）</b>
            </span>
            <span className="pchip">
              院校{' '}
              <b>
                {selection.school === 'undecided'
                  ? '未定'
                  : `${selection.school.key}（${selection.school.value}）`}
              </b>
            </span>
            <span className="pchip">
              学生类型 <b>{studentLabel}（{selection.studentTypeCode}）</b>
            </span>
          </div>
        )}

        <div className="phases">
          <div className={`phase ${translating ? 'done' : 'active'}`}>
            <span className="ic">{translating ? '✓' : <span className="mini-spin" />}</span>
            搜索官网材料清单
            <span className="right">
              {translating
                ? `${state.searchDetail ?? ''}${state.searchMs !== undefined ? ` · ${(state.searchMs / 1000).toFixed(1)}s` : ''}`
                : '判定 + 抓取 + 解析'}
            </span>
          </div>
          {translating ? (
            <div className="phase active">
              <span className="ic">
                <span className="mini-spin" />
              </span>
              <span className="grow">
                翻译成中文（中英双语对照）
                <div className="bar">
                  <i style={{ width: `${pct}%` }} />
                </div>
              </span>
              <span className="right">
                {state.progress ? `${state.progress.done} / ${state.progress.total} 条` : '…'}
              </span>
            </div>
          ) : (
            <div className="phase pending">
              <span className="ic">◦</span>翻译成中文（中英双语对照）
              <span className="right">等待中</span>
            </div>
          )}
        </div>

        {state.fallback && (
          <div className="fallback-note">
            <span>⚠️</span>
            <span>
              <b>
                {PROVIDER_LABEL[state.fallback.from]}
                {state.fallback.errorKind === 'quota' ? ' 套餐额度已用尽' : ' 调用失败'}
              </b>
              {state.fallback.to ? (
                <>
                  ，已按 fallback 顺序自动切换至 <b>{PROVIDER_LABEL[state.fallback.to]}</b>
                </>
              ) : (
                '，无下一顺位可切换'
              )}
              。结果元信息将记录实际使用的 provider，详情见 设置 → 日志。
            </span>
          </div>
        )}

        {state.error && (
          <div className="gen-error">
            ⚠️ {state.error}
            <div className="gen-error-actions">
              <button className="btn-ghost" onClick={props.onBack}>
                返回修改
              </button>
              <button className="btn-ghost" onClick={props.onRetry}>
                重试
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="footer-actions">
        <span>
          详细执行过程记录于{' '}
          <a
            className="log-link"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              props.onOpenLogs();
            }}
          >
            设置 → 日志
          </a>
        </span>
        {!state.error && (
          <button className="btn-ghost" onClick={props.onCancel}>
            取消
          </button>
        )}
      </div>
    </div>
  );
}
