/*
 * AI Provider 层错误分类——fallback 判定的唯一依据（类型驱动，非字符串匹配）。
 * 矩阵见设计文档：auth/rate-limit/quota/server/parse 可 fallback；network 直接抛。
 */

import type { ProviderId } from '../../common/types.ts';

export type AiErrorKind = 'auth' | 'rate-limit' | 'quota' | 'server' | 'parse' | 'network';

export class AiError extends Error {
  readonly kind: AiErrorKind;
  readonly provider?: ProviderId;
  constructor(kind: AiErrorKind, message: string, provider?: ProviderId) {
    super(message);
    this.name = 'AiError';
    this.kind = kind;
    this.provider = provider;
  }
}

export const FALLBACK_KINDS: readonly AiErrorKind[] = ['auth', 'rate-limit', 'quota', 'server', 'parse'];

export interface AiAttempt {
  provider: ProviderId;
  model: string;
  error: AiError;
}

export class AiExhaustedError extends Error {
  readonly attempts: AiAttempt[];
  constructor(attempts: AiAttempt[]) {
    super(
      `全部已启用的 AI provider 均失败：${attempts
        .map((a) => `${a.provider}(${a.error.kind})`)
        .join(' → ')}`
    );
    this.name = 'AiExhaustedError';
    this.attempts = attempts;
  }
}

/**
 * HTTP/SDK 错误 → AiErrorKind。三家共用一套判定（duck-typing status/code/type，
 * 不依赖各 SDK 的错误类 instanceof——注入的 mock 与真实错误同样适用）。
 */
export function classifyProviderError(e: unknown, provider: ProviderId): AiError {
  const err = e as {
    status?: number;
    code?: string;
    type?: string;
    error?: { type?: string; code?: string };
    message?: string;
  };
  const msg = typeof err?.message === 'string' ? err.message : String(e);
  const status = typeof err?.status === 'number' ? err.status : undefined;
  const code = err?.code ?? err?.error?.code;
  const type = err?.type ?? err?.error?.type;

  const quotaSignal =
    code === 'insufficient_quota' ||
    type === 'billing_error' ||
    /quota|insufficient[_ ]?credit|balance|额度|套餐/i.test(msg);

  if (status === undefined) {
    return new AiError('network', `网络不可达：${msg}`, provider);
  }
  if (status === 402 || quotaSignal) {
    return new AiError('quota', `套餐/配额耗尽：${msg}`, provider);
  }
  if (status === 401 || status === 403) {
    return new AiError('auth', `认证失败（${status}）：${msg}`, provider);
  }
  if (status === 429) {
    return new AiError('rate-limit', `限流（429）：${msg}`, provider);
  }
  if (status >= 500) {
    return new AiError('server', `服务端错误（${status}）：${msg}`, provider);
  }
  // 其余 4xx（如 400 请求不合法）视为该 provider 不可用——按可 fallback 的 server 类处理，
  // 避免单家 SDK 参数差异卡死整条链
  return new AiError('server', `请求被拒绝（${status}）：${msg}`, provider);
}
