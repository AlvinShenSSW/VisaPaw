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
  DEEPSEEK_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL,
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
  pingSchema,
  translateSchema,
  translateUserPrompt,
} from './prompts.ts';

export interface AiMeta {
  provider: ProviderId;
  model: string;
}

export type AiEvent =
  | { type: 'skip'; provider: ProviderId; reason: 'no-key' | 'disabled' }
  /** 尝试开始——UI 可即时显示当前 provider（Codex PR#26 P2） */
  | { type: 'attempt'; provider: ProviderId; model: string }
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
    case 'deepseek':
      return createOpenAiCompatAdapter({
        id: 'deepseek',
        apiKey: spec.apiKey,
        model: spec.model,
        baseURL: DEEPSEEK_BASE_URL,
        // DeepSeek 兼容端不支持 strict json_schema，只支持 json_object（Codex PR#38 P1）
        schemaMode: 'json_object',
      });
  }
}

export function resolveModel(id: ProviderId, configured: string): string {
  if (configured) return configured;
  switch (id) {
    case 'claude':
      return CLAUDE_DEFAULT_MODEL;
    case 'openai':
      return OPENAI_DEFAULT_MODEL;
    case 'deepseek':
      return DEEPSEEK_DEFAULT_MODEL;
    case 'mimo':
      return MIMO_DEFAULT_MODEL;
  }
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
      emit({ type: 'attempt', provider: setting.id, model });

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
          // 下家必须真的可尝试：已启用且配了 key——否则日志会指向一个立即被 skip 的
          // provider（Codex 外门 P2）
          next: providers.slice(i + 1).find((p) => p.enabled && deps.getKey(p.id))?.id,
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

/**
 * 单 provider 连接测试（设置页「测试」按钮）——最小结构化 ping，
 * 不走 fallback 链；失败以 AiError 抛出供 UI 分类提示。请求体无任何个人信息。
 */
export async function pingProvider(
  spec: AdapterSpec,
  factory: (spec: AdapterSpec) => ProviderAdapter = defaultAdapterFactory,
  timeoutMs = 15_000
): Promise<void> {
  const adapter = factory(spec);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 超时保护——挂死的 provider 不得让设置页按钮无限「测试中」（Kimi PR#32 minor）
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new AiError('network', `连接测试超时（${Math.round(timeoutMs / 1000)}s 无响应）`, spec.id)
          ),
        timeoutMs
      );
    });
    const raw = await Promise.race([
      adapter.callStructured({
        system: '你是连接测试端点。只返回符合给定 JSON schema 的输出。',
        user: '返回 {"pong": true}',
        schema: pingSchema,
        schemaName: 'ping_result',
      }),
      timeout,
    ]);
    const parsed = pingSchema.safeParse(raw);
    if (!parsed.success || parsed.data.pong !== true) {
      throw new AiError('parse', '测试响应内容不符合预期', spec.id);
    }
  } catch (e) {
    throw toAiError(e, spec.id);
  } finally {
    clearTimeout(timer);
  }
}
