import { describe, it, expect, vi } from 'vitest';
import { createAiService, pingProvider, resolveModel, type AiEvent, type AiService } from '../electron/ai/orchestrator.ts';
import { AiError, AiExhaustedError, type AiErrorKind } from '../electron/ai/errors.ts';
import type { ProviderAdapter } from '../electron/ai/adapters.ts';
import type { ProviderId, ProviderSetting } from '../common/types.ts';

const P = (id: ProviderId, enabled = true, model = ''): ProviderSetting => ({ id, enabled, model });

/** 构造按脚本行为的假 adapter 工厂：scripts[id] 为每次调用依次执行的行为 */
function scriptedFactory(scripts: Partial<Record<ProviderId, Array<AiError | unknown>>>) {
  const calls: Record<string, number> = {};
  const factory = (spec: { id: ProviderId; model: string }): ProviderAdapter => ({
    id: spec.id,
    model: spec.model,
    async callStructured() {
      const idx = (calls[spec.id] = (calls[spec.id] ?? 0) + 1) - 1;
      const script = scripts[spec.id] ?? [];
      const step = script[Math.min(idx, script.length - 1)];
      if (step instanceof AiError) throw step;
      return step;
    },
  });
  return { factory, calls };
}

const OK = { translations: ['一', '二'] };
const ITEMS = ['one', 'two'];

function service(
  providers: ProviderSetting[],
  scripts: Parameters<typeof scriptedFactory>[0],
  keys: Partial<Record<ProviderId, string | null>> = {}
) {
  const events: AiEvent[] = [];
  const { factory, calls } = scriptedFactory(scripts);
  const svc = createAiService({
    settings: { providers },
    getKey: (id) => (id in keys ? (keys[id] ?? null) : 'key'),
    adapterFactory: factory,
    onEvent: (e) => events.push(e),
  });
  return { svc, events, calls };
}

describe('错误矩阵（F5 决议：逐项断言 fallback 行为）', () => {
  const fallbackKinds: AiErrorKind[] = ['auth', 'rate-limit', 'quota', 'server'];

  for (const kind of fallbackKinds) {
    it(`${kind} → fallback 到下一家，元信息记录实际成功者`, async () => {
      const { svc, events, calls } = service([P('mimo'), P('claude')], {
        mimo: [new AiError(kind, `${kind} 模拟`, 'mimo')],
        claude: [OK],
      });
      const res = await svc.translate(ITEMS);
      expect(res.translations).toEqual(['一', '二']);
      expect(res.meta).toEqual({ provider: 'claude', model: 'claude-opus-4-8' });
      expect(calls.mimo).toBe(1); // 非 parse 错误不重试
      const fb = events.find((e) => e.type === 'fallback');
      expect(fb).toMatchObject({ provider: 'mimo', errorKind: kind });
    });
  }

  it('quota（MiMo 套餐额度耗尽）→ fallback 事件携带 kind=quota 供 UI 提示', async () => {
    const { svc, events } = service([P('mimo'), P('claude')], {
      mimo: [new AiError('quota', 'Token Plan 套餐额度已用尽', 'mimo')],
      claude: [OK],
    });
    await svc.translate(ITEMS);
    expect(events.find((e) => e.type === 'fallback')).toMatchObject({
      errorKind: 'quota',
      message: expect.stringContaining('额度'),
    });
  });

  it('parse → 同 provider 重试一次成功，不 fallback', async () => {
    const { svc, events, calls } = service([P('claude'), P('openai')], {
      claude: [new AiError('parse', 'bad json', 'claude'), OK],
    });
    const res = await svc.translate(ITEMS);
    expect(res.meta.provider).toBe('claude');
    expect(calls.claude).toBe(2);
    expect(calls.openai).toBeUndefined();
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(1);
    expect(events.find((e) => e.type === 'fallback')).toBeUndefined();
  });

  it('parse → 重试一次仍失败才 fallback（共 2 次调用）', async () => {
    const { svc, calls } = service([P('claude'), P('openai')], {
      claude: [new AiError('parse', 'x', 'claude'), new AiError('parse', 'y', 'claude')],
      openai: [OK],
    });
    const res = await svc.translate(ITEMS);
    expect(res.meta.provider).toBe('openai');
    expect(calls.claude).toBe(2);
  });

  it('network → 不 fallback，直接抛出；下一家绝不被调用', async () => {
    const { svc, calls } = service([P('claude'), P('openai')], {
      claude: [new AiError('network', '断网', 'claude')],
      openai: [OK],
    });
    await expect(svc.translate(ITEMS)).rejects.toMatchObject({ kind: 'network' });
    expect(calls.openai).toBeUndefined();
  });

  it('全部失败 → AiExhaustedError 携带完整 attempts 链', async () => {
    const { svc } = service([P('mimo'), P('claude'), P('openai')], {
      mimo: [new AiError('quota', 'q', 'mimo')],
      claude: [new AiError('auth', 'a', 'claude')],
      openai: [new AiError('server', 's', 'openai')],
    });
    const err = (await svc.translate(ITEMS).catch((e: unknown) => e)) as AiExhaustedError;
    expect(err).toBeInstanceOf(AiExhaustedError);
    expect(err.attempts.map((a) => [a.provider, a.error.kind])).toEqual([
      ['mimo', 'quota'],
      ['claude', 'auth'],
      ['openai', 'server'],
    ]);
  });
});

describe('顺序、启用与 key 门槛', () => {
  it('严格按 settings 数组顺序（fallback 顺序 = 拖拽排序）', async () => {
    const { svc } = service([P('mimo'), P('openai'), P('claude')], { mimo: [OK] });
    const res = await svc.translate(ITEMS);
    expect(res.meta).toEqual({ provider: 'mimo', model: 'mimo-v2.5-pro' });
  });

  it('未启用与未配 key 的 provider 被跳过并记录事件（不算错误）', async () => {
    const { svc, events } = service(
      [P('mimo', false), P('openai'), P('claude')],
      { claude: [OK] },
      { openai: null }
    );
    const res = await svc.translate(ITEMS);
    expect(res.meta.provider).toBe('claude');
    expect(events).toContainEqual({ type: 'skip', provider: 'mimo', reason: 'disabled' });
    expect(events).toContainEqual({ type: 'skip', provider: 'openai', reason: 'no-key' });
  });

  it('settings 配置的模型覆盖默认值并记录到元信息', async () => {
    const { svc } = service([P('claude', true, 'claude-sonnet-5')], { claude: [OK] });
    const res = await svc.translate(ITEMS);
    expect(res.meta.model).toBe('claude-sonnet-5');
  });
});

describe('结构化输出校验（等长与候选约束）', () => {
  it('译文数组长度不等 → 视为 parse：重试一次后 fallback', async () => {
    const short = { translations: ['只有一条'] };
    const { svc, calls } = service([P('claude'), P('openai')], {
      claude: [short, short],
      openai: [OK],
    });
    const res = await svc.translate(ITEMS);
    expect(res.meta.provider).toBe('openai');
    expect(calls.claude).toBe(2);
  });

  it('classifySection：归类结果必须在候选分类中', async () => {
    const { svc } = service([P('claude'), P('openai')], {
      claude: [{ category: '不存在的分类' }, { category: '不存在的分类' }],
      openai: [{ category: '教育与工作背景类' }],
    });
    const res = await svc.classifySection('Special categories', ['个人身份类', '教育与工作背景类']);
    expect(res.category).toBe('教育与工作背景类');
    expect(res.meta.provider).toBe('openai');
  });

  it('spy 校验成功路径 success 事件与调用次数', async () => {
    const onEvent = vi.fn();
    const { factory } = scriptedFactory({ claude: [OK] });
    const svc = createAiService({
      settings: { providers: [P('claude')] },
      getKey: () => 'k',
      adapterFactory: factory,
      onEvent,
    });
    await svc.translate(ITEMS);
    expect(onEvent).toHaveBeenCalledWith({
      type: 'success',
      provider: 'claude',
      model: 'claude-opus-4-8',
    });
  });
});

describe('pingProvider（设置页「测试」按钮的最小连接测试）', () => {
  const spec = { id: 'mimo' as const, apiKey: 'k', model: 'mimo-v2.5-pro' };
  const stub = (impl: () => Promise<unknown>) =>
    () => ({ id: spec.id, model: spec.model, callStructured: impl });

  it('适配器返回 {pong:true} → 通过', async () => {
    await expect(pingProvider(spec, stub(async () => ({ pong: true })))).resolves.toBeUndefined();
  });

  it('AiError 原样抛出（auth 等种类供 UI 分类提示）', async () => {
    await expect(
      pingProvider(spec, stub(async () => Promise.reject(new AiError('auth', 'bad key', 'mimo'))))
    ).rejects.toMatchObject({ kind: 'auth' });
  });

  it('响应不符合 schema / pong≠true → parse', async () => {
    await expect(pingProvider(spec, stub(async () => ({})))).rejects.toMatchObject({ kind: 'parse' });
    await expect(pingProvider(spec, stub(async () => ({ pong: false })))).rejects.toMatchObject({
      kind: 'parse',
    });
  });

  it('非 AiError 异常包装为 server（不泄露堆栈语义给 UI）', async () => {
    await expect(
      pingProvider(spec, stub(async () => Promise.reject(new Error('boom'))))
    ).rejects.toMatchObject({ kind: 'server' });
  });

  it('挂死的 provider 超时 → network（设置页按钮不得无限「测试中」）', async () => {
    await expect(
      pingProvider(spec, stub(() => new Promise(() => undefined)), 20)
    ).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('DeepSeek（#34：新 provider 接入编排链）', () => {
  it('resolveModel：未配置时取 deepseek-v4-flash 默认', () => {
    expect(resolveModel('deepseek', '')).toBe('deepseek-v4-flash');
    expect(resolveModel('deepseek', 'deepseek-chat')).toBe('deepseek-chat');
  });

  it('四家链路：mimo quota → deepseek 接手；错误矩阵语义与其余 provider 一致', async () => {
    const events: AiEvent[] = [];
    const service = createAiService({
      settings: {
        providers: [
          { id: 'mimo', enabled: true, model: '' },
          { id: 'deepseek', enabled: true, model: '' },
          { id: 'openai', enabled: false, model: '' },
          { id: 'claude', enabled: false, model: '' },
        ],
      },
      getKey: () => 'k',
      onEvent: (e) => events.push(e),
      adapterFactory: (spec) => ({
        id: spec.id,
        model: spec.model,
        callStructured: async () => {
          if (spec.id === 'mimo') throw new AiError('quota', '额度耗尽', 'mimo');
          return { translations: ['一'] };
        },
      }),
    });
    const { meta } = await service.translate(['one']);
    expect(meta).toEqual({ provider: 'deepseek', model: 'deepseek-v4-flash' });
    expect(events.find((e) => e.type === 'fallback')).toMatchObject({
      provider: 'mimo',
      errorKind: 'quota',
      next: 'deepseek',
    });
  });

  it('deepseek auth 失败 → fallback 下一家；network 直接抛出不 fallback', async () => {
    const make = (kind: 'auth' | 'network'): AiService =>
      createAiService({
        settings: {
          providers: [
            { id: 'deepseek', enabled: true, model: '' },
            { id: 'claude', enabled: true, model: '' },
          ],
        },
        getKey: () => 'k',
        adapterFactory: (spec) => ({
          id: spec.id,
          model: spec.model,
          callStructured: async () => {
            if (spec.id === 'deepseek') throw new AiError(kind, `${kind} 注入`, 'deepseek');
            return { translations: ['一'] };
          },
        }),
      });
    const ok = await make('auth').translate(['one']);
    expect(ok.meta.provider).toBe('claude');
    await expect(make('network').translate(['one'])).rejects.toMatchObject({ kind: 'network' });
  });
});
