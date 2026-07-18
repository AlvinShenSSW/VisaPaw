/*
 * 设置页（#12）——严格按 mockups/04：macOS 标签栏、Provider 卡片（拖拽排序 =
 * fallback 顺序、macOS toggle、掩码 key、模型选择、MiMo 警示、Keychain 提示条）、
 * 日志标签（运行下拉、毫秒时间戳着色、导出/清空）。
 * #12 决议：key 明文/掩码不进 renderer——掩码为静态占位（prefix + 定长点）。
 */

import { useEffect, useRef, useState } from 'react';
import type {
  ProviderId,
  ProviderSetting,
  RunLog,
  RunSummary,
  Settings as AppSettings,
  VaultStatus,
} from '../../common/types.ts';
import {
  clock,
  levelClass,
  maskDisplay,
  providerMeta,
  reorderProviders,
  runOptionLabel,
  statusPill,
} from './settings-model.ts';

type TabId = 'general' | 'provider' | 'logs' | 'cache' | 'about';

const TABS: Array<{ id: TabId; icon: string; label: string }> = [
  { id: 'general', icon: '⚙️', label: '通用' },
  { id: 'provider', icon: '🤖', label: 'AI Provider' },
  { id: 'logs', icon: '📜', label: '日志' },
  { id: 'cache', icon: '🗂', label: '数据缓存' },
  { id: 'about', icon: 'ℹ️', label: '关于' },
];

export type SettingsTabId = TabId;

export interface SettingsViewProps {
  settings: AppSettings;
  onSettingsChange(next: AppSettings): void;
  initialTab?: TabId;
}

export function SettingsView(props: SettingsViewProps): React.JSX.Element {
  const [tab, setTab] = useState<TabId>(props.initialTab ?? 'provider');
  return (
    <>
      <div className="tabs">
        {TABS.map((t) => (
          <div key={t.id} className={`tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
            <div className="icon">{t.icon}</div>
            {t.label}
          </div>
        ))}
      </div>
      <div className="settings-content">
        {tab === 'provider' && <ProviderTab {...props} />}
        {tab === 'logs' && <LogsTab />}
        {tab !== 'provider' && tab !== 'logs' && (
          <div className="settings-empty">「{TABS.find((t) => t.id === tab)?.label}」设置将在后续迭代提供。</div>
        )}
      </div>
    </>
  );
}

/* ------------------------------- AI Provider ------------------------------- */

function ProviderTab(props: SettingsViewProps): React.JSX.Element {
  const [keyStatus, setKeyStatus] = useState<VaultStatus | null>(null);
  const [editing, setEditing] = useState<ProviderId | null>(null);
  const [draftKey, setDraftKey] = useState('');
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  // 设置写入串行化——并发乐观更新的迟到失败会把 UI 回滚到过期状态（Kimi PR#28 P2）
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());

  const refreshKeys = (): void => {
    window.visapaw?.getProviderKeyStatus().then(setKeyStatus).catch(() => setKeyStatus(null));
  };
  useEffect(refreshKeys, []);

  const providers = props.settings.providers;

  const persist = (nextProviders: ProviderSetting[]): void => {
    const prev = props.settings;
    props.onSettingsChange({ ...prev, providers: nextProviders });
    setSaveError(null);
    saveChain.current = saveChain.current.then(() =>
      (window.visapaw?.setSettings({ providers: nextProviders }) ?? Promise.resolve(null))
        .then((saved) => {
          if (saved) props.onSettingsChange(saved); // 以持久化结果为准
        })
        .catch((e: Error) => {
          // 落盘失败必须回滚并显性化——否则展示链与持久化不一致（Codex PR#28 P2）
          props.onSettingsChange(prev);
          setSaveError(`设置保存失败：${e.message}`);
        })
    );
  };

  const saveKey = (id: ProviderId): void => {
    if (!draftKey.trim()) return;
    setKeyError(null);
    window.visapaw
      ?.setProviderKey(id, draftKey.trim())
      .then((st) => {
        setKeyStatus(st);
        setEditing(null);
        setDraftKey('');
      })
      .catch((e: Error) => {
        // Keychain 写入失败必须显性化——静默失败会让用户误以为已保存（Kimi PR#28 P2）
        setKeyError(`API key 保存失败：${e.message}`);
      });
  };

  return (
    <>
      <div className="section-head">
        <h2>AI Provider 管理</h2>
        <p>
          用于清单翻译与未命中章节的兜底归类。可启用多家并<b>拖拽排序</b>
          ：翻译按顺序调用，前一家失败（认证失败 / 限流 / 套餐额度耗尽 / 服务端错误）自动 fallback
          到下一家。
        </p>
      </div>
      <div className="order-hint">
        <span className="arrows">⇅</span>
        拖动左侧手柄调整 fallback 顺序 · 三家共用同一份术语表与 prompt 模板，切换后术语一致
      </div>
      {saveError && <div className="p-note warn">⚠️ {saveError}</div>}
      {keyError && <div className="p-note warn">⚠️ {keyError}</div>}

      {providers.map((p, i) => {
        const meta = providerMeta(p.id);
        const key = keyStatus?.providers[p.id];
        const pill = statusPill(p, key, keyStatus?.error ?? null);
        const isEditing = editing === p.id;
        return (
          <div
            key={p.id}
            className={`provider${p.enabled ? '' : ' disabled'}${dragFrom === i ? ' dragging' : ''}`}
            draggable
            onDragStart={() => setDragFrom(i)}
            onDragEnd={() => setDragFrom(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragFrom !== null && dragFrom !== i) persist(reorderProviders(providers, dragFrom, i));
              setDragFrom(null);
            }}
          >
            <div className="p-head">
              <span className="drag" title="拖拽排序">
                ⠿
              </span>
              <span className="order-no">{i + 1}</span>
              <span className={`p-logo logo-${p.id}`}>{meta.logo}</span>
              <div className="p-name">
                {meta.name}
                <small>{meta.small}</small>
              </div>
              <div className="p-status">
                <span className={`pill pill-${pill.kind}`}>{pill.text}</span>
                <button
                  className={`toggle${p.enabled ? ' on' : ''}`}
                  role="switch"
                  aria-checked={p.enabled}
                  onClick={() =>
                    persist(providers.map((x) => (x.id === p.id ? { ...x, enabled: !x.enabled } : x)))
                  }
                />
              </div>
            </div>
            <div className="p-body">
              <div className="frow">
                <label>API Key</label>
                {key?.saved && !isEditing ? (
                  <>
                    <input className="input key" type="text" value={maskDisplay(key)} readOnly />
                    <button
                      className="mini-btn"
                      onClick={() => {
                        setEditing(p.id);
                        setDraftKey('');
                      }}
                    >
                      更换
                    </button>
                    <span className="verified">✓ 已保存</span>
                  </>
                ) : (
                  <>
                    <input
                      className="input key"
                      type="password"
                      placeholder={p.id === 'openai' ? 'sk-… 添加 API key 以启用' : '粘贴 API key'}
                      value={editing === p.id ? draftKey : ''}
                      onFocus={() => setEditing(p.id)}
                      onChange={(e) => setDraftKey(e.target.value)}
                    />
                    <button className="mini-btn" onClick={() => saveKey(p.id)}>
                      保存至 Keychain
                    </button>
                  </>
                )}
              </div>
              <div className="frow">
                <label>模型</label>
                {p.id === 'openai' ? (
                  <input
                    className="input"
                    type="text"
                    placeholder="默认取当期旗舰（gpt-5.2，可改）"
                    value={p.model}
                    onChange={(e) =>
                      persist(providers.map((x) => (x.id === p.id ? { ...x, model: e.target.value } : x)))
                    }
                  />
                ) : (
                  <select
                    className="select"
                    value={p.model || meta.models[0].value}
                    onChange={(e) =>
                      persist(providers.map((x) => (x.id === p.id ? { ...x, model: e.target.value } : x)))
                    }
                  >
                    {meta.models.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {p.id === 'mimo' && (
                <div className="p-note warn">
                  ⚠️ Token Plan 套餐计费：额度耗尽会返回配额错误，App 会将其视为可 fallback
                  错误并自动切换至下一顺位 provider，同时在生成进度中提示。
                </div>
              )}
              {p.id === 'claude' && (
                <div className="p-note">按量计费 · 术语表已注入 system prompt 并启用 prompt caching。</div>
              )}
            </div>
          </div>
        );
      })}

      <div className="keychain">
        <span className="icon">🔐</span>
        <span>
          <b>密钥安全：</b>所有 API key 均存储于 <b>macOS Keychain</b>
          （按 provider 命名空间隔离），不落盘明文；发送给 AI
          的内容仅为官网公开清单文本，永不包含申请人姓名、护照号等个人信息。
        </span>
      </div>
    </>
  );
}

/* ---------------------------------- 日志 ---------------------------------- */

function LogsTab(): React.JSX.Element {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [runLog, setRunLog] = useState<RunLog | null>(null);

  const refresh = (): void => {
    window.visapaw
      ?.listRunLogs()
      .then((list) => {
        setRuns(list);
        setSelected((cur) => cur ?? list[0]?.id ?? null);
      })
      .catch(() => setRuns([]));
  };
  useEffect(refresh, []);
  useEffect(() => {
    if (!selected) {
      setRunLog(null);
      return;
    }
    let stop = false;
    const load = (): void => {
      window.visapaw
        ?.getRunLog(selected)
        .then((log) => {
          if (!stop) setRunLog(log);
        })
        .catch(() => {
          if (!stop) setRunLog(null);
        });
    };
    load();
    // 运行中的 run 持续刷新——生成期间打开日志页也能看到实时条目（Codex PR#28 P2）
    const timer = setInterval(() => {
      setRunLog((cur) => {
        if (cur?.summary.status === 'running') load();
        return cur;
      });
    }, 1000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [selected]);

  const exportLog = (): void => {
    if (!selected) return;
    window.visapaw?.exportRunLog(selected).then((text) => {
      if (!text) return;
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${selected}.log.txt`;
      a.click();
      // 立即 revoke 可能取消尚未开始的下载（Kimi PR#28 minor）
      setTimeout(() => URL.revokeObjectURL(a.href), 0);
    });
  };

  const clearLogs = (): void => {
    window.visapaw?.clearRunLogs().then(() => {
      setRuns([]);
      setSelected(null);
      setRunLog(null);
    });
  };

  const summary = runLog?.summary;
  return (
    <>
      <div className="section-head">
        <h2>生成日志</h2>
        <p>每次生成的判定 / 抓取 / 解析 / 分类 / 备注 / 翻译与 fallback 事件，仅存本机。</p>
      </div>
      <div className="log-toolbar">
        <select className="select" value={selected ?? ''} onChange={(e) => setSelected(e.target.value || null)}>
          {runs.length === 0 && <option value="">暂无运行记录</option>}
          {runs.map((r, i) => (
            <option key={r.id} value={r.id}>
              {runOptionLabel(r)}
              {i === 0 ? '（最近一次）' : ''}
            </option>
          ))}
        </select>
        <div className="spacer" />
        <button className="mini-btn" onClick={exportLog} disabled={!selected}>
          导出日志
        </button>
        <button className="mini-btn" onClick={clearLogs} disabled={runs.length === 0}>
          清空
        </button>
      </div>

      {summary ? (
        <div className="run-entry">
          <div className="run-head">
            <b>{runOptionLabel(summary).split(' · ')[0]}</b>
            <span>
              {summary.params.country} · {summary.params.cricosCode} · 学生类型{' '}
              {summary.params.studentTypeCode}
            </span>
            {summary.totalMs !== undefined && <span>总耗时 {(summary.totalMs / 1000).toFixed(1)}s</span>}
            <span
              className={`pill ${summary.status === 'success' ? (summary.translationFailed ? 'pill-warn' : 'pill-ok') : 'pill-warn'}`}
            >
              {summary.status === 'success' ? (summary.translationFailed ? '成功（翻译降级）' : '成功') : '失败'}
            </span>
          </div>
          <div className="log-body">
            {runLog?.entries.map((e, i) => (
              <span className="lg" key={i}>
                <span className="t">{clock(e.ts)}</span>
                <span className={`k ${levelClass(e.level)}`}>{e.stage}</span>
                {e.message}
                {e.durationMs !== undefined && `（${(e.durationMs / 1000).toFixed(1)}s）`}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className="settings-empty">生成一次清单后，这里会展示完整执行过程。</div>
      )}
    </>
  );
}
