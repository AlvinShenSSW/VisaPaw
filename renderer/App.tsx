/*
 * 应用壳：标题栏（hiddenInset 原生红绿灯）+ 三步向导路由 + 状态栏。
 * Step 1 按 mockups/01（#9）；Step 2/3 由 #10/#11 落地。
 */

import { useEffect, useState } from 'react';
import type { Settings } from '../common/types.ts';
import { providerChainLabel } from './lib/status.ts';
import { Step1, type Step1Selection } from './views/Step1.tsx';

export function App(): React.JSX.Element {
  const [version, setVersion] = useState('');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [, setSelection] = useState<Step1Selection | null>(null);

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
  }, []);

  return (
    <div className="shell">
      <header className="titlebar">
        <span className="title">🐾 VisaPaw</span>
        <span className="gear" title="设置">
          ⚙︎
        </span>
      </header>
      <Step1
        settings={settings}
        onGenerate={(sel) => {
          // Step 2 生成流程由 #10 接线；先保存选择
          setSelection(sel);
        }}
      />
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
