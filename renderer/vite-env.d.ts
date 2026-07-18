/// <reference types="vite/client" />

import type { VisapawBridge } from '../common/types.ts';

declare global {
  interface Window {
    /** preload 白名单桥；纯浏览器打开 renderer 时不存在 */
    visapaw?: VisapawBridge;
  }
}

export {};
