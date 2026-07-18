/*
 * 应用壳：标题栏（hiddenInset 原生红绿灯）+ 三步向导路由 + 状态栏。
 * Step 1（#9）→ Step 2 生成（#10，IPC 流式进度 + 取消）→ Step 3（#11）。
 */

import { useEffect, useRef, useState } from 'react';
import type { GenerateResult, Settings } from '../common/types.ts';
import { providerChainLabel } from './lib/status.ts';
import { Step1, type Step1Selection } from './views/Step1.tsx';
import { Step2, reduceProgress, type Step2State } from './views/Step2.tsx';
import { Step3 } from './views/Step3.tsx';
import { SettingsView } from './views/Settings.tsx';

type Route = { step: 1 } | { step: 2; selection: Step1Selection } | { step: 3; result: GenerateResult };

export function App(): React.JSX.Element {
  const [version, setVersion] = useState('');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [route, setRoute] = useState<Route>({ step: 1 });
  const [progress, setProgress] = useState<Step2State>({ phase: 'search' });
  const [enAllOpen, setEnAllOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
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
      .then((result) => {
        unsubRef.current?.();
        unsubRef.current = null;
        if (mountedRef.current) setRoute({ step: 3, result });
      })
      .catch((e: Error) => {
        unsubRef.current?.();
        unsubRef.current = null;
        if (!mountedRef.current) return;
        if (e.message.includes('CANCELLED')) {
          setRoute({ step: 1 });
        } else {
          // 错误分层视图由 #13 落地；先以内联错误保留在 Step 2
          setProgress((prev) => ({ ...prev, error: e.message }));
        }
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
            : `🐾 VisaPaw${route.step === 2 ? ' — 生成清单' : route.step === 3 ? ' — 生成结果' : ''}`}
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
        <SettingsView settings={settings} onSettingsChange={setSettings} />
      )}
      {!showSettings && route.step === 1 && <Step1 settings={settings} onGenerate={startGenerate} />}
      {!showSettings && route.step === 2 && (
        <Step2
          selection={route.selection}
          state={progress}
          onCancel={cancelGenerate}
          onOpenLogs={() => undefined /* 设置页由 #12 落地 */}
          onBack={() => setRoute({ step: 1 })}
          onRetry={() => startGenerate(route.selection)}
        />
      )}
      {!showSettings && route.step === 3 && (
        <Step3
          result={route.result}
          allOpen={enAllOpen}
          onExport={(kind) => {
            // 三种导出由 #14 落地
            console.warn(`导出（${kind}）由 #14 实现`);
          }}
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
