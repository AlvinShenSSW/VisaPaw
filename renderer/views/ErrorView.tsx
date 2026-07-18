/*
 * 异常与降级状态（#13）——严格按 mockups/05：
 * A 网络失败 / B 官网 403 / C 结构指纹失败 → WebView 降级（保留用户三项选择——PR#17 P1 决议）。
 * 错误由结构化 kind 驱动（非字符串匹配）。状态 D 在 Step3 内以翻译横幅呈现。
 */

import { useState } from 'react';
import type { GenerateOutcome } from '../../common/types.ts';
import type { Step1Selection } from './Step1.tsx';
import { STUDENT_TYPES } from './Step1.tsx';

const TOOL_URL = 'https://immi.homeaffairs.gov.au/visas/web-evidentiary-tool';
const RELEASES_URL = 'https://github.com/AlvinShenSSW/VisaPaw/releases';

export interface ErrorViewProps {
  outcome: Extract<GenerateOutcome, { ok: false }>;
  selection: Step1Selection;
  onRetry(): void;
  onBack(): void;
}

export function ErrorView(props: ErrorViewProps): React.JSX.Element {
  const { outcome } = props;
  if (outcome.kind === 'structure') return <WebViewFallback {...props} />;
  if (outcome.kind === 'forbidden') return <ForbiddenPanel {...props} />;
  return <NetworkPanel {...props} />;
}

function DetailToggle({ message }: { message: string }): React.JSX.Element {
  const [show, setShow] = useState(false);
  return (
    <>
      <button className="btn" onClick={() => setShow((v) => !v)}>
        {show ? '收起详情' : '查看详情'}
      </button>
      {show && <div className="err-raw">{message}</div>}
    </>
  );
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* 状态 A：网络失败（与 403 文案分开） */
function NetworkPanel(props: ErrorViewProps): React.JSX.Element {
  return (
    <div className="err-panel">
      <div className="err-icon">📡</div>
      <h3>无法连接到移民局官网</h3>
      <p>
        请求 <code>immi.homeaffairs.gov.au</code>{' '}
        超时，可能是当前网络不可用或不稳定。请检查网络连接后重试；本次生成未消耗任何 AI 额度。
      </p>
      <div className="err-actions">
        <DetailToggle message={props.outcome.message} />
        <button className="btn" onClick={props.onBack}>
          返回
        </button>
        <button className="btn btn-primary" onClick={props.onRetry}>
          重试
        </button>
      </div>
      <div className="err-detail">错误代码：NET_TIMEOUT · {timestamp()}</div>
    </div>
  );
}

/* 状态 B：官网 403（与网络失败明确区分） */
function ForbiddenPanel(props: ErrorViewProps): React.JSX.Element {
  return (
    <div className="err-panel">
      <div className="err-icon warn">🚫</div>
      <h3>官网拒绝了本次访问（HTTP 403）</h3>
      <p>
        移民局官网拒绝了来自当前网络的请求。这通常发生在使用<b>数据中心 IP / 部分 VPN 或公司代理</b>
        时——官网只接受住宅网络直连。请切换到家庭 / 手机热点等普通网络后重试。
      </p>
      <div className="err-actions">
        <DetailToggle message={props.outcome.message} />
        <button className="btn" onClick={props.onBack}>
          返回
        </button>
        <button className="btn btn-primary" onClick={props.onRetry}>
          切换网络后重试
        </button>
      </div>
      <div className="err-detail">错误代码：HTTP_403_FORBIDDEN · GET /visas/web-evidentiary-tool</div>
    </div>
  );
}

/* 状态 C：结构指纹失败 → 内嵌 WebView 手动模式 + 「App 需要更新」提示条 */
function WebViewFallback(props: ErrorViewProps): React.JSX.Element {
  const { selection } = props;
  const studentLabel =
    STUDENT_TYPES.find(([c]) => c === selection.studentTypeCode)?.[1].split(' — ')[0] ??
    selection.studentTypeCode;
  return (
    <>
      <div className="update-bar">
        <span>⚠️</span>
        <span className="grow">
          <b>官网页面结构已变化，自动解析暂不可用。</b>
          已为您打开官网工具手动操作；请留意 App 更新以恢复一键生成。
        </span>
        <button
          className="bar-btn"
          onClick={() => window.open(RELEASES_URL, '_blank', 'noopener')}
        >
          检查更新
        </button>
        <button className="bar-btn" onClick={props.onRetry}>
          重试自动解析
        </button>
      </div>
      {/* 官网无预填参数——展示用户全部已选项供照抄（含学生类型，PR#17 P1 决议） */}
      <div className="selection-bar">
        <span>
          您此前的选择（请在官网表单中照抄）：国籍 <b>{selection.country.key}</b>
        </span>
        <span>
          院校{' '}
          <b>
            {selection.school === 'undecided'
              ? '未定（选 “Not listed”）'
              : `${selection.school.key}（${selection.school.value}）`}
          </b>
        </span>
        <span>
          学生类型 <b>{studentLabel}（{selection.studentTypeCode}）</b>
        </span>
      </div>
      <div className="wv-host">
        <div className="wv-chrome">
          <div className="wv-url">
            <span className="lock">🔒</span>immi.homeaffairs.gov.au/visas/web-evidentiary-tool
          </div>
        </div>
        <webview src={TOOL_URL} />
        <div className="wv-note">
          手动模式下结果为官网英文原版：不含翻译、分类与合规备注。App 恢复解析能力后可重新一键生成。
        </div>
      </div>
    </>
  );
}
