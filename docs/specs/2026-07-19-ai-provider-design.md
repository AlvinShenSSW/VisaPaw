# #8 AI Provider 层 — 设计文档

- 日期：2026-07-19 ｜ Issue：[#8](https://github.com/AlvinShenSSW/VisaPaw/issues/8)

## 分层

```
orchestrator（fallback 编排，translator/兜底归类共用）
  └─ adapters：claude / openai / mimo（SDK 客户端注入 → 单测全 mock，不烧真实 key）
       └─ prompts（三家共用术语表模板 + zod schema）
```

## 错误分类（AiError.kind）与 fallback 矩阵（F5 决议）

| kind | 来源 | fallback？ |
|---|---|---|
| `auth` | 401/403（Anthropic AuthenticationError/PermissionDeniedError；OpenAI status 401/403） | ✅ |
| `rate-limit` | 429 | ✅ |
| `quota` | 套餐/配额耗尽（MiMo Token Plan 配额错误、OpenAI insufficient_quota、Anthropic billing） | ✅（UI 提示「MiMo 套餐额度已用尽」由 #10/#12 消费 kind） |
| `server` | 5xx/529 | ✅ |
| `parse` | 结构化输出解析失败/长度不等——**同 provider 重试一次**，再失败才 fallback | ✅（重试后） |
| `network` | 网络完全不可用（APIConnectionError / fetch 断网） | ❌ 直接抛出 |

- 表驱动矩阵测试逐项断言：是否 fallback、重试次数、最终错误、元信息记录。
- fallback 事件经注入的 `onEvent` 回调发出（#15 日志管道消费；#10 提示条消费）。

## 接口

- `translate(items: string[]) → {translations: string[]}`——**等长校验**（zod + 长度断言，不等视为 parse）
- `classifySection(sectionName, categories[]) → {category}`——#6 兜底归类用
- 编排返回 `{result, provider, model}` 元信息（红线：文档记录实际 provider/模型）
- 输入只允许官网公开清单文本（红线 2）；调用方（pipeline）负责不传入个人信息——本层不接收任何用户身份字段，接口签名上即不可能

## 三家接入

| Provider | SDK | 结构化输出 | 模型 |
|---|---|---|---|
| Claude | `@anthropic-ai/sdk` | `output_config.format`（json_schema，由 zod 转换） + 术语表 system 块 `cache_control: ephemeral`（注：Opus 4.8 最小可缓存前缀 4096 tokens，术语表较小可能不触发缓存——标注为尽力而为） | `claude-opus-4-8` 默认，可切 `claude-sonnet-5`（settings） |
| ChatGPT | `openai` | `response_format: {type:'json_schema', strict}` | settings 可选；默认常量 `gpt-5.2`（当期旗舰按 SPEC 由用户在设置确认；错误自动 fallback 不阻断） |
| MiMo | `openai` SDK + baseURL 覆写（常量，官网文档变更时调整） | 同 ChatGPT | `mimo-v2.5-pro` 默认 / `mimo-v2.5` |

- key 从 credential-store（Keychain）读取，仅 main process；未配 key 的 provider 视为不可用直接跳过（记录 skip 事件，不算错误）
- 术语表：CoE=入学确认书、OSHC=海外学生健康保险、GS=真实学生要求、CRICOS、Form 956/956A 等，三家同一 system 模板保证切换后术语一致

## 测试

adapters：mock SDK 客户端（注入工厂）——结构化调用参数形状、错误映射逐类；orchestrator：mock adapter——错误矩阵全覆盖、顺序遵从 settings、跳过未配 key、全部失败抛 exhausted（保留英文清单由 #13 状态 D 消费）、断网即抛不 fallback、元信息与事件记录。
