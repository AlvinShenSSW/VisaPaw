/*
 * Step 2 视图状态与进度事件折叠（纯模块，无 JSX——electron 侧测试可直接引用）。
 */

import type { ProgressEvent, ProviderId } from '../../common/types.ts';

export interface Step2State {
  phase: 'search' | 'translate';
  searchDetail?: string;
  searchMs?: number;
  summary?: { checklistType: string; sections: number; items: number };
  provider?: { provider: ProviderId; model: string };
  progress?: { done: number; total: number };
  fallback?: { from: ProviderId; fromModel: string; to?: ProviderId; errorKind: string };
  error?: string;
}

/** 进度事件折叠为视图状态（纯函数，单测覆盖） */
export function reduceProgress(state: Step2State, e: ProgressEvent): Step2State {
  switch (e.type) {
    case 'phase':
      if (e.phase === 'search' && e.status === 'done') {
        return { ...state, phase: 'translate', searchDetail: e.detail, searchMs: e.durationMs };
      }
      if (e.phase === 'translate' && e.status === 'active') {
        return { ...state, phase: 'translate' };
      }
      return state;
    case 'summary':
      return { ...state, summary: e };
    case 'provider':
      return { ...state, provider: { provider: e.provider, model: e.model } };
    case 'translate-progress':
      return { ...state, progress: { done: e.done, total: e.total } };
    case 'fallback-note':
      return { ...state, fallback: e };
    default:
      return state;
  }
}
