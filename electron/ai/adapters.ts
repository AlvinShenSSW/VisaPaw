/*
 * 三家 provider 适配器——SDK 客户端经工厂注入（单测全 mock，不消耗真实 key）。
 * Claude：@anthropic-ai/sdk，结构化输出 output_config.format + 术语表块 cache_control；
 * ChatGPT / MiMo：openai SDK（MiMo 走 baseURL 覆写），response_format: json_schema(strict)。
 * 红线：请求体中只有官网公开清单文本——本层接口不存在个人信息字段。
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { z } from 'zod';
import type { ProviderId } from '../../common/types.ts';
import { AiError, classifyProviderError } from './errors.ts';
import { toStrictJsonSchema } from './prompts.ts';

/** MiMo Token 计划 OpenAI 兼容端点（2026-07-19 实测；以官方文档为准，变更时在此调整） */
export const MIMO_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1';
/** OpenAI 默认模型（SPEC：设置中可选、默认取当期旗舰；错误会触发 fallback，不阻断） */
export const OPENAI_DEFAULT_MODEL = 'gpt-5.2';
export const CLAUDE_DEFAULT_MODEL = 'claude-opus-4-8';
export const MIMO_DEFAULT_MODEL = 'mimo-v2.5-pro';

export interface StructuredCall {
  system: string;
  user: string;
  schema: z.ZodType;
  schemaName: string;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly model: string;
  /** 返回解析后的 JSON（未经 zod 校验——编排层统一校验/重试）；失败抛 AiError */
  callStructured(call: StructuredCall): Promise<unknown>;
}

/* ---------------------------------- Claude ---------------------------------- */

/** 供注入替身的最小客户端面 */
export interface ClaudeClientLike {
  messages: {
    create(params: Record<string, unknown>): Promise<{
      content: Array<{ type: string; text?: string }>;
    }>;
  };
}

export interface ClaudeAdapterConfig {
  apiKey: string;
  model?: string;
  clientFactory?: (apiKey: string) => ClaudeClientLike;
}

export function createClaudeAdapter(cfg: ClaudeAdapterConfig): ProviderAdapter {
  const model = cfg.model || CLAUDE_DEFAULT_MODEL;
  const factory: (apiKey: string) => ClaudeClientLike =
    cfg.clientFactory ?? ((apiKey) => new Anthropic({ apiKey }) as unknown as ClaudeClientLike);
  const client = factory(cfg.apiKey);
  return {
    id: 'claude',
    model,
    async callStructured(call) {
      let text: string | undefined;
      try {
        const res = await client.messages.create({
          model,
          max_tokens: 16000,
          // 术语表模板是稳定前缀——尽力而为缓存（Opus 4.8 最小可缓存前缀 4096 tokens）
          system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: call.user }],
          output_config: {
            format: { type: 'json_schema', schema: toStrictJsonSchema(call.schema) },
          },
        });
        text = res.content.find((b) => b.type === 'text')?.text;
      } catch (e) {
        throw classifyProviderError(e, 'claude');
      }
      return parseJsonOrThrow(text, 'claude');
    },
  };
}

/* ---------------------------- OpenAI 兼容（ChatGPT / MiMo） ---------------------------- */

export interface OpenAiClientLike {
  chat: {
    completions: {
      create(params: Record<string, unknown>): Promise<{
        choices: Array<{ message?: { content?: string | null } }>;
      }>;
    };
  };
}

export interface OpenAiCompatAdapterConfig {
  id: ProviderId;
  apiKey: string;
  model: string;
  baseURL?: string;
  clientFactory?: (apiKey: string, baseURL?: string) => OpenAiClientLike;
}

export function createOpenAiCompatAdapter(cfg: OpenAiCompatAdapterConfig): ProviderAdapter {
  const factory: (apiKey: string, baseURL?: string) => OpenAiClientLike =
    cfg.clientFactory ??
    ((apiKey, baseURL) => new OpenAI({ apiKey, baseURL }) as unknown as OpenAiClientLike);
  const client = factory(cfg.apiKey, cfg.baseURL);
  return {
    id: cfg.id,
    model: cfg.model,
    async callStructured(call) {
      let text: string | null | undefined;
      try {
        const res = await client.chat.completions.create({
          model: cfg.model,
          messages: [
            { role: 'system', content: call.system },
            { role: 'user', content: call.user },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: call.schemaName,
              strict: true,
              schema: toStrictJsonSchema(call.schema),
            },
          },
        });
        text = res.choices[0]?.message?.content;
      } catch (e) {
        throw classifyProviderError(e, cfg.id);
      }
      return parseJsonOrThrow(text ?? undefined, cfg.id);
    },
  };
}

/* ---------------------------------- 公共 ---------------------------------- */

function parseJsonOrThrow(text: string | undefined, provider: ProviderId): unknown {
  if (!text) {
    throw new AiError('parse', '模型未返回文本内容', provider);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // 容错抽取：推理模型（MiMo 等）常把 JSON 包在 <think> 段或 ```json 围栏里，
    // 或前后带说明文字——剥壳后再试一次，仍失败才判 parse（同 provider 重试一次的
    // 编排策略不变）
    const stripped = extractJsonPayload(text);
    if (stripped !== null) {
      try {
        return JSON.parse(stripped) as unknown;
      } catch {
        /* 落入下方统一 parse 错误 */
      }
    }
    throw new AiError('parse', `模型输出不是合法 JSON：${text.slice(0, 120)}…`, provider);
  }
}

/**
 * 从含杂质的模型输出中抽取 JSON 文本；无法定位时返回 null。
 * 平衡括号扫描并尊重字符串转义——首末括号截取会被字符串值内的 }/] 或
 * JSON 后的尾随文字截错位置（Kimi PR#32 P2）
 */
function extractJsonPayload(text: string): string | null {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) t = fence[1].trim();
  const start = t.search(/[[{]/);
  if (start === -1) return null;
  const open = t[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < t.length; i += 1) {
    const c = t[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === open) {
      depth += 1;
    } else if (c === close) {
      depth -= 1;
      if (depth === 0) return t.slice(start, i + 1);
    }
  }
  return null;
}
