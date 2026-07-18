/// <reference types="vite/client" />

import type { VisapawBridge } from '../common/types.ts';

declare global {
  interface Window {
    /** preload 白名单桥；纯浏览器打开 renderer 时不存在 */
    visapaw?: VisapawBridge;
  }
  namespace React {
    namespace JSX {
      interface IntrinsicElements {
        /** Electron webview（状态 C 降级；安全约束在 main 侧施加） */
        webview: React.DetailedHTMLProps<
          React.HTMLAttributes<HTMLElement> & { src?: string; partition?: string },
          HTMLElement
        >;
      }
    }
  }
}

export {};
