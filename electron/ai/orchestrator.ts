/*
 * fallback 编排——translator 与 #6 兜底归类共用：
 * 按 settings 顺序尝试已启用且配了 key 的 provider；
 * parse 错误同家重试一次；auth/rate-limit/quota/server/parse(重试后) → 下一家；
 * network 直接抛出不 fallback（SPEC §8）；全部失败抛 AiExhaustedError（#13 状态 D 消费）。
 * 每次成功返回实际 provider/model 元信息（红线 5）；事件经 onEvent 供 #15 日志与 #10 提示条。
 */

import type { ProviderId, Settings } from '../../common/types.ts';
import {
  AiError,
  AiExhaustedError,
  FALLBACK_KINDS,
  type AiAttempt,
  type AiErrorKind,
} from './errors.ts';
import {
  CLAUDE_DEFAULT_MODEL,
  MIMO_BASE_URL,
  MIMO_DEFAULT_MODEL,
  OPENAI_DEFAULT_MODEL,
  createClaudeAdapter,
  createOpenAiCompatAdapter,
  type ProviderAdapter,
  type StructuredCall,
} from './adapters.ts';
import {
  buildClassifySystemPrompt,
  buildSystemPrompt,
  classifySchema,
  classifyUserPrompt,
  translateSchema,
  translateUserPrompt,
} from './prompts.ts';

export interface AiMeta {
  provider: ProviderId;
  model: string;
}

export type AiEvent =
  | { type: 'skip'; provider: ProviderId; reason: 'no-key' | 'disabled' }
  | { type: 'retry'; provider: ProviderId; model: string; errorKind: 'parse' }
  | {
      type: 'fallback';
      provider: ProviderId;
      model: string;
      errorKind: AiErrorKind;
      message: string;
      /** 链上下一个已启用的 provider（#15 日志「前后 provider」；无下家为 undefined） */
      next?: ProviderId;
    }
  | { type: 'success'; provider: ProviderId; model: string };

export interface AdapterSpec {
  id: ProviderId;
  apiKey: string;
  model: string;
}

export interface AiServiceDeps {
  settings: Pick<Settings, 'providers'>;
  getKey(provider: ProviderId): string | null;
  onEvent?: (e: AiEvent) => void;
  /** 测试注入；缺省构建真实 SDK 适配器 */
  adapterFactory?: (spec: AdapterSpec) => ProviderAdapter;
}

export interface AiService {
  translate(items: string[]): Promise<{ translations: string[]; meta: AiMeta }>;
  classifySection(
    sectionName: string,
    categories: string[]
  ): Promise<{ category: string; meta: AiMeta }>;
}

function defaultAdapterFactory(spec: AdapterSpec): ProviderAdapter {
  switch (spec.id) {
    case 'claude':
      return createClaudeAdapter({ apiKey: spec.apiKey, model: spec.model });
    case 'openai':
      return createOpenAiCompatAdapter({ id: 'openai', apiKey: spec.apiKey, model: spec.model });
    case 'mimo':
      return createOpenAiCompatAdapter({
        id: 'mimo',
        apiKey: spec.apiKey,
        model: spec.model,
        baseURL: MIMO_BASE_URL,
      });
  }
}

function resolveModel(id: ProviderId, configured: string): string {
  if (configured) return configured;
  return id === 'claude'
    ? CLAUDE_DEFAULT_MODEL
    : id === 'openai'
      ? OPENAI_DEFAULT_MODEL
      : MIMO_DEFAULT_MODEL;
}

export function createAiService(deps: AiServiceDeps): AiService {
  const factory = deps.adapterFactory ?? defaultAdapterFactory;
  const emit = deps.onEvent ?? (() => undefined);

  async function runStructured<T>(
    call: StructuredCall,
    validate: (raw: unknown, provider: ProviderId) => T
  ): Promise<{ value: T; meta: AiMeta }> {
    const attempts: AiAttempt[] = [];
    const providers = deps.settings.providers;
    for (let i = 0; i < providers.length; i++) {
      const setting = providers[i];
      if (!setting.enabled) {
        emit({ type: 'skip', provider: setting.id, reason: 'disabled' });
        continue;
      }
      const apiKey = deps.getKey(setting.id);
      if (!apiKey) {
        emit({ type: 'skip', provider: setting.id, reason: 'no-key' });
        continue;
      }
      const model = resolveModel(setting.id, setting.model);
      const adapter = factory({ id: setting.id, apiKey, model });

      const attemptOnce = async (): Promise<T> => {
        const raw = await adapter.callStructured(call);
        try {
          return validate(raw, setting.id);
        } catch (e) {
          if (e instanceof AiError) throw e;
          throw new AiError('parse', `结构化输出校验失败：${(e as Error).message}`, setting.id);
        }
      };

      try {
        let value: T;
        try {
          value = await attemptOnce();
        } catch (first) {
          const firstErr = toAiError(first, setting.id);
          if (firstErr.kind !== 'parse') throw firstErr;
          // 结构化输出解析失败：同 provider 重试一次（SPEC §8）
          emit({ type: 'retry', provider: setting.id, model, errorKind: 'parse' });
          value = await attemptOnce();
        }
        emit({ type: 'success', provider: setting.id, model });
        return { value, meta: { provider: setting.id, model } };
      } catch (e) {
        const err = toAiError(e, setting.id);
        if (err.kind === 'network') {
          // 网络完全不可用：不 fallback，直接抛出（SPEC §8）
          throw err;
        }
        if (!FALLBACK_KINDS.includes(err.kind)) throw err;
        attempts.push({ provider: setting.id, model, error: err });
        emit({
          type: 'fallback',
          provider: setting.id,
          model,
          errorKind: err.kind,
          message: err.message,
          next: providers.slice(i + 1).find((p) => p.enabled)?.id,
        });
      }
    }
    throw new AiExhaustedError(attempts);
  }

  return {
    async translate(items) {
      const { value, meta } = await runStructured(
        {
          system: buildSystemPrompt(),
          user: translateUserPrompt(items),
          schema: translateSchema,
          schemaName: 'translate_result',
        },
        (raw, provider) => {
          const parsed = translateSchema.parse(raw);
          if (parsed.translations.length !== items.length) {
            throw new AiError(
              'parse',
              `译文数组长度不等：期望 ${items.length}，得到 ${parsed.translations.length}`,
              provider
            );
          }
          return parsed;
        }
      );
      return { translations: value.translations, meta };
    },

    async classifySection(sectionName, categories) {
      const { value, meta } = await runStructured(
        {
          system: buildClassifySystemPrompt(),
          user: classifyUserPrompt(sectionName, categories),
          schema: classifySchema,
          schemaName: 'classify_result',
        },
        (raw, provider) => {
          const parsed = classifySchema.parse(raw);
          if (!categories.includes(parsed.category)) {
            throw new AiError('parse', `归类结果不在候选分类中：${parsed.category}`, provider);
          }
          return parsed;
        }
      );
      return { category: value.category, meta };
    },
  };
}

function toAiError(e: unknown, provider: ProviderId): AiError {
  if (e instanceof AiError) return e;
  return new AiError('server', `未知错误：${(e as Error)?.message ?? String(e)}`, provider);
}
