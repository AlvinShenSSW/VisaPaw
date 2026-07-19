import { describe, it, expect, vi } from 'vitest';
import {
  createClaudeAdapter,
  createOpenAiCompatAdapter,
  MIMO_BASE_URL,
  type ClaudeClientLike,
  type OpenAiClientLike,
} from '../electron/ai/adapters.ts';
import { classifyProviderError } from '../electron/ai/errors.ts';
import { buildSystemPrompt, translateSchema, GLOSSARY, toStrictJsonSchema } from '../electron/ai/prompts.ts';

const CALL = {
  system: buildSystemPrompt(),
  user: 'user prompt',
  schema: translateSchema,
  schemaName: 'translate_result',
};

describe('Claude 适配器', () => {
  it('结构化输出走 output_config.format；术语表 system 块带 cache_control', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"translations":["一"]}' }],
    });
    const client: ClaudeClientLike = { messages: { create } };
    const adapter = createClaudeAdapter({ apiKey: 'k', clientFactory: () => client });
    const raw = await adapter.callStructured(CALL);
    expect(raw).toEqual({ translations: ['一'] });
    const params = create.mock.calls[0][0] as Record<string, unknown>;
    expect(params.model).toBe('claude-opus-4-8');
    const system = params.system as Array<Record<string, unknown>>;
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
    const oc = params.output_config as { format: { type: string; schema: Record<string, unknown> } };
    expect(oc.format.type).toBe('json_schema');
    expect(oc.format.schema.additionalProperties).toBe(false);
  });

  it('SDK 错误经统一分类映射（429 → rate-limit）', async () => {
    const client: ClaudeClientLike = {
      messages: { create: vi.fn().mockRejectedValue(Object.assign(new Error('rl'), { status: 429 })) },
    };
    const adapter = createClaudeAdapter({ apiKey: 'k', clientFactory: () => client });
    await expect(adapter.callStructured(CALL)).rejects.toMatchObject({ kind: 'rate-limit' });
  });

  it('非 JSON 输出 → parse 错误', async () => {
    const client: ClaudeClientLike = {
      messages: {
        create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'not-json' }] }),
      },
    };
    const adapter = createClaudeAdapter({ apiKey: 'k', clientFactory: () => client });
    await expect(adapter.callStructured(CALL)).rejects.toMatchObject({ kind: 'parse' });
  });
});

describe('OpenAI 兼容适配器（ChatGPT / MiMo）', () => {
  it('response_format 为 strict json_schema；MiMo 用 baseURL 覆写', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"translations":["一"]}' } }],
    });
    const seen: { baseURL?: string } = {};
    const factory = (_k: string, baseURL?: string): OpenAiClientLike => {
      seen.baseURL = baseURL;
      return { chat: { completions: { create } } };
    };
    const adapter = createOpenAiCompatAdapter({
      id: 'mimo',
      apiKey: 'k',
      model: 'mimo-v2.5-pro',
      baseURL: MIMO_BASE_URL,
      clientFactory: factory,
    });
    await adapter.callStructured(CALL);
    expect(seen.baseURL).toBe(MIMO_BASE_URL);
    interface RF {
      response_format: {
        type: string;
        json_schema: { strict: boolean; schema: Record<string, unknown> };
      };
      messages: Array<{ role: string; content: string }>;
    }
    const params = create.mock.calls[0][0] as unknown as RF;
    expect(params.response_format.type).toBe('json_schema');
    expect(params.response_format.json_schema.strict).toBe(true);
    expect(params.response_format.json_schema.schema.additionalProperties).toBe(false);
    expect(params.messages[0]).toEqual({ role: 'system', content: CALL.system });
  });

  it('空 choices/content → parse 错误', async () => {
    const client: OpenAiClientLike = {
      chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [] }) } },
    };
    const adapter = createOpenAiCompatAdapter({ id: 'openai', apiKey: 'k', model: 'm', clientFactory: () => client });
    await expect(adapter.callStructured(CALL)).rejects.toMatchObject({ kind: 'parse' });
  });

  it('容错解析：<think> 段 / ```json 围栏 / 前后说明文字均能剥壳（MiMo 实测 parse 修复）', async () => {
    const wrapped = [
      '<think>先想一想这些条目怎么翻</think>\n```json\n{"translations":["一"]}\n```',
      '```\n{"translations":["一"]}\n```',
      '好的，以下是翻译结果：\n{"translations":["一"]}\n如需调整请告知。',
    ];
    for (const content of wrapped) {
      const client: OpenAiClientLike = {
        chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content } }] }) } },
      };
      const adapter = createOpenAiCompatAdapter({ id: 'mimo', apiKey: 'k', model: 'm', clientFactory: () => client });
      await expect(adapter.callStructured(CALL)).resolves.toEqual({ translations: ['一'] });
    }
  });

  it('剥壳后仍不是 JSON → parse 错误（不静默吞坏输出）', async () => {
    const client: OpenAiClientLike = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({ choices: [{ message: { content: '完全没有 JSON 的回复 { 残缺' } }] }),
        },
      },
    };
    const adapter = createOpenAiCompatAdapter({ id: 'mimo', apiKey: 'k', model: 'm', clientFactory: () => client });
    await expect(adapter.callStructured(CALL)).rejects.toMatchObject({ kind: 'parse' });
  });
});

describe('classifyProviderError（三家共用错误映射）', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ status: 401, message: 'invalid key' }, 'auth'],
    [{ status: 403, message: 'forbidden' }, 'auth'],
    [{ status: 429, message: 'rate limited' }, 'rate-limit'],
    [{ status: 429, code: 'insufficient_quota', message: 'quota' }, 'quota'],
    [{ status: 402, message: 'payment required' }, 'quota'],
    [{ status: 403, type: 'billing_error', message: 'billing' }, 'quota'],
    [{ status: 429, message: 'Token Plan 套餐额度已用尽' }, 'quota'],
    [{ status: 500, message: 'ise' }, 'server'],
    [{ status: 529, message: 'overloaded' }, 'server'],
    [{ status: 400, message: 'bad request' }, 'server'],
    [{ message: 'fetch failed' }, 'network'],
    [{ message: 'connect ECONNREFUSED 127.0.0.1:443' }, 'network'],
    [{ name: 'AbortError', message: 'The operation timed out' }, 'network'],
    // 无 status 但非连接层（SDK 解析畸形响应）→ parse，可重试/fallback（Codex 外门 P2）
    [{ name: 'SyntaxError', message: 'Unexpected token < in JSON' }, 'parse'],
    [{ name: 'TypeError', message: "Cannot read properties of undefined (reading 'choices')" }, 'parse'],
    // 无 status 的配额错误不得丢失 quota 语义（Kimi 终审 P2）
    [{ code: 'insufficient_quota', message: 'You exceeded your current quota' }, 'quota'],
    // status 0 = fetch/代理无响应 → network（Kimi 终审 P2）
    [{ status: 0, message: 'no response' }, 'network'],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => {
      const err = Object.assign(new Error(String(input.message)), input);
      if (typeof input.name === 'string') err.name = input.name;
      expect(classifyProviderError(err, 'claude').kind).toBe(expected);
    });
  }
});

describe('prompts（三家共用术语表与 schema）', () => {
  it('术语表覆盖 AGENTS 点名术语且进 system 模板', () => {
    const sys = buildSystemPrompt();
    for (const term of ['入学确认书（CoE）', '海外学生健康保险（OSHC）', '真实学生要求（GS）', 'CRICOS', 'Form 956A']) {
      expect(sys).toContain(term);
    }
    expect(GLOSSARY.length).toBeGreaterThanOrEqual(8);
  });

  it('zod → strict JSON Schema（对象全 required + additionalProperties:false，无 $schema）', () => {
    const json = toStrictJsonSchema(translateSchema);
    expect(json.$schema).toBeUndefined();
    expect(json.additionalProperties).toBe(false);
    expect(json.required).toEqual(['translations']);
  });
});
