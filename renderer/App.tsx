/*
 * #3 骨架壳：标题栏（hiddenInset 原生红绿灯）+ 三步向导容器占位 + 状态栏。
 * 真实页面在 #9–#13 按 mockups/ 对应稿实现（mockup 为唯一视觉验收基准）。
 */

import { useEffect, useState } from 'react';

export function App(): React.JSX.Element {
  const [version, setVersion] = useState('');

  useEffect(() => {
    // dev 下直接在浏览器打开时无 preload 桥——骨架壳允许缺省
    window.visapaw
      ?.getSystemStatus()
      .then((s) => setVersion(s.version))
      .catch(() => undefined);
  }, []);

  return (
    <div className="shell">
      <header className="titlebar">
        <span className="title">VisaPaw</span>
        <span className="gear" title="设置">
          ⚙︎
        </span>
      </header>
      <main className="content">
        <div className="placeholder-card">
          <h1>澳大利亚学生签证（Subclass 500）申请材料清单</h1>
          <p>骨架就绪——三步向导与设置页由 #9–#13 按 mockups 落地</p>
          <div className="steps">
            <span className="active">① 填写申请信息</span>
            <span>② 生成清单</span>
            <span>③ 查看结果</span>
          </div>
        </div>
      </main>
      <footer className="statusbar">
        <span className="dot" />
        <span>immi.homeaffairs.gov.au</span>
        <span>{version && `v${version}`}</span>
      </footer>
    </div>
  );
}
