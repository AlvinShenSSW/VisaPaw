/*
 * 应用壳：标题栏（hiddenInset 原生红绿灯）+ 三步向导路由 + 状态栏。
 * Step 1（#9）→ Step 2 生成（#10，IPC 流式进度 + 取消）→ Step 3（#11）。
 */

import { useEffect, useRef, useState } from 'react';
import type { GenerateResult, Settings } from '../common/types.ts';
import { providerChainLabel } from './lib/status.ts';
import { Step1, type Step1Selection } from './views/Step1.tsx';
import { Step2, reduceProgress, type Step2State } from './views/Step2.tsx';

type Route = { step: 1 } | { step: 2; selection: Step1Selection } | { step: 3; result: GenerateResult };

export function App(): React.JSX.Element {
  const [version, setVersion] = useState('');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [route, setRoute] = useState<Route>({ step: 1 });
  const [progress, setProgress] = useState<Step2State>({ phase: 'search' });
  const unsubRef = useRef<(() => void) | null>(null);

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
    return () => unsubRef.current?.();
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
        setRoute({ step: 3, result });
      })
      .catch((e: Error) => {
        unsubRef.current?.();
        unsubRef.current = null;
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
        <span className="title">🐾 VisaPaw{route.step === 2 ? ' — 生成清单' : ''}</span>
        <span className="gear" title="设置">
          ⚙︎
        </span>
      </header>
      {route.step === 1 && <Step1 settings={settings} onGenerate={startGenerate} />}
      {route.step === 2 && (
        <Step2
          selection={route.selection}
          state={progress}
          onCancel={cancelGenerate}
          onOpenLogs={() => undefined /* 设置页由 #12 落地 */}
        />
      )}
      {route.step === 3 && (
        <div className="content">
          {/* Step 3 结果视图由 #11 按 mockups/03 落地；当前展示占位摘要 */}
          <div className="hero">
            <h1>
              <span className="paw">清单已生成</span>（{route.result.checklistType}）
            </h1>
            <p>
              {route.result.groups.length} 个分类 · 抓取时间 {route.result.fetchedAt} ·{' '}
              {route.result.translationFailed ? '翻译暂不可用（保留英文清单）' : '中英双语对照'}
            </p>
          </div>
        </div>
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
