/*
 * 应用壳：标题栏（hiddenInset 原生红绿灯）+ 三步向导路由 + 状态栏。
 * Step 1（#9）→ Step 2 生成（#10，IPC 流式进度 + 取消）→ Step 3（#11）。
 */

import { useEffect, useRef, useState } from 'react';
import type { GenerateOutcome, GenerateResult, Settings } from '../common/types.ts';
import { ErrorView } from './views/ErrorView.tsx';
import { providerChainLabel } from './lib/status.ts';
import { Step1, type Step1Selection } from './views/Step1.tsx';
import { Step2, reduceProgress, type Step2State } from './views/Step2.tsx';
import { Step3 } from './views/Step3.tsx';
import { SettingsView } from './views/Settings.tsx';

type Route =
  | { step: 1 }
  | { step: 2; selection: Step1Selection }
  | { step: 3; result: GenerateResult }
  | { step: 'error'; outcome: Extract<GenerateOutcome, { ok: false }>; selection: Step1Selection };

export function App(): React.JSX.Element {
  const [version, setVersion] = useState('');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [route, setRoute] = useState<Route>({ step: 1 });
  const [progress, setProgress] = useState<Step2State>({ phase: 'search' });
  const [enAllOpen, setEnAllOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'provider' | 'logs'>('provider');
  const unsubRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    // dev 下直接在浏览器打开时无 preload 桥——壳允许缺省
    window.visapaw
      ?.getSystemStatus()
      .then((s) => setVersion(s.version))
      .catch(() => undefined);
    window.visapaw
      ?.getSettings()
      .then(setSettings)
      .catch(() => undefined);
    return () => {
      mountedRef.current = false; // 卸载后 IPC 回调不得 setState（Kimi PR#26 P2）
      unsubRef.current?.();
    };
  }, []);

  const startGenerate = (selection: Step1Selection): void => {
    if (!window.visapaw) return;
    setProgress({ phase: 'search' });
    setRoute({ step: 2, selection });
    unsubRef.current?.();
    unsubRef.current = window.visapaw.onGenerateProgress((e) =>
      setProgress((prev) => reduceProgress(prev, e))
    );
    window.visapaw
      .startGenerate(selection)
      .then((outcome) => {
        unsubRef.current?.();
        unsubRef.current = null;
        if (!mountedRef.current) return;
        if (outcome.ok) {
          setRoute({ step: 3, result: outcome.result });
        } else if (outcome.kind === 'cancelled') {
          setRoute({ step: 1 });
        } else {
          // 三类错误分层视图（#13，类型驱动）
          setRoute({ step: 'error', outcome, selection });
        }
      })
      .catch((e: Error) => {
        unsubRef.current?.();
        unsubRef.current = null;
        if (!mountedRef.current) return;
        setRoute({
          step: 'error',
          outcome: { ok: false, kind: 'unknown', message: e.message },
          selection,
        });
      });
  };

  const cancelGenerate = (): void => {
    void window.visapaw?.cancelGenerate();
  };

  return (
    <div className="shell">
      <header className="titlebar">
        <span className="title">
          {showSettings
            ? 'VisaPaw 设置'
            : route.step === 'error' && route.outcome.kind === 'structure'
              ? '🐾 VisaPaw — 官网手动模式（降级）'
              : `🐾 VisaPaw${
                  route.step === 2
                    ? ' — 生成清单'
                    : route.step === 3
                      ? route.result.translationFailed
                        ? ' — 生成结果（未翻译）'
                        : ' — 生成结果'
                      : ''
                }`}
        </span>
        {!showSettings && route.step === 3 && (
          <span className="tools">
            <button className="tb-btn" onClick={() => setEnAllOpen((v) => !v)}>
              {enAllOpen ? '收起全部英文' : '展开全部英文'}
            </button>
            <button
              className="tb-btn"
              onClick={() => {
                setEnAllOpen(false);
                setRoute({ step: 1 });
              }}
            >
              重新生成
            </button>
          </span>
        )}
        {showSettings && (
          <span className="tools">
            <button className="tb-btn" onClick={() => setShowSettings(false)}>
              完成
            </button>
          </span>
        )}
        <span
          className="gear"
          title="设置"
          onClick={() => setShowSettings((v) => !v)}
          style={{ cursor: 'pointer' }}
        >
          ⚙︎
        </span>
      </header>
      {showSettings && settings && (
        <SettingsView
          key={settingsTab}
          settings={settings}
          onSettingsChange={setSettings}
          initialTab={settingsTab}
        />
      )}
      {!showSettings && route.step === 1 && <Step1 settings={settings} onGenerate={startGenerate} />}
      {!showSettings && route.step === 2 && (
        <Step2
          selection={route.selection}
          state={progress}
          onCancel={cancelGenerate}
          onOpenLogs={() => {
            // 生成期间可直达 设置 → 日志（Codex PR#28 P2）
            setSettingsTab('logs');
            setShowSettings(true);
          }}
          onBack={() => setRoute({ step: 1 })}
          onRetry={() => startGenerate(route.selection)}
        />
      )}
      {!showSettings && route.step === 3 && (
        <Step3
          result={route.result}
          allOpen={enAllOpen}
          onExport={(kind) => {
            window.visapaw
              ?.exportResult(kind, route.result)
              .then((r) => {
                if (!r.ok && r.message !== '已取消') console.warn(`导出失败：${r.message}`);
              })
              .catch(() => undefined);
          }}
          retryingTranslation={retrying}
          retryError={retryError}
          onRetryTranslation={() => {
            if (!window.visapaw || retrying) return;
            setRetrying(true);
            setRetryError(null);
            const target = route.result;
            window.visapaw
              .retryTranslation(target)
              .then((outcome) => {
                if (!mountedRef.current) return;
                if (outcome.ok) {
                  // 仅当仍停留在同一结果时才替换——防迟到响应覆盖新导航（Codex PR#29 P2）
                  setRoute((prev) =>
                    prev.step === 3 && prev.result === target
                      ? { step: 3, result: outcome.result }
                      : prev
                  );
                } else {
                  // 重试失败必须显性化，英文清单保留（Codex PR#29 P2）
                  setRetryError(outcome.message);
                }
              })
              .finally(() => {
                if (mountedRef.current) setRetrying(false);
              });
          }}
        />
      )}
      {!showSettings && route.step === 'error' && (
        <ErrorView
          outcome={route.outcome}
          selection={route.selection}
          onRetry={() => startGenerate(route.selection)}
          onBack={() => setRoute({ step: 1 })}
        />
      )}
      <footer className="statusbar">
        <span>
          <span className="dot" />
          immi.homeaffairs.gov.au
        </span>
        <span>{settings ? providerChainLabel(settings.providers) : ''}</span>
        <span className="right">{version && `v${version} · Iteration 1`}</span>
      </footer>
    </div>
  );
}
