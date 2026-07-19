/*
 * 三家 provider 共用的术语表与 prompt 模板（AGENTS：保证切换 provider 后术语一致）。
 * 结构化输出 schema 用 zod 定义，JSON Schema 由 z.toJSONSchema 生成并强制 strict 对象。
 */

import { z } from 'zod';

/** 官方术语表：英文术语 → 中文定译（中文为主、术语保留英文括注） */
export const GLOSSARY: ReadonlyArray<readonly [string, string]> = [
  ['CoE (Confirmation of Enrolment)', '入学确认书（CoE）'],
  ['OSHC (Overseas Student Health Cover)', '海外学生健康保险（OSHC）'],
  ['GS (Genuine Student) requirement', '真实学生要求（GS）'],
  ['CRICOS', 'CRICOS（澳大利亚政府海外学生课程与院校注册码）'],
  ['Form 956', 'Form 956（移民代理/豁免人士提供移民协助通知书）'],
  ['Form 956A', 'Form 956A（指定/撤销授权接收人通知书）'],
  ['Subclass 500', '学生签证（Subclass 500）'],
  ['certified translation', '宣誓翻译（certified translation）'],
  ['police certificate / police check', '无犯罪记录证明（police certificate）'],
  ['Department of Home Affairs', '澳大利亚内政部（Department of Home Affairs）'],
];

/** 术语表 system 模板——三家共用；Claude 侧此文本块加 cache_control */
export function buildSystemPrompt(): string {
  const glossaryLines = GLOSSARY.map(([en, zh]) => `- ${en} → ${zh}`).join('\n');
  return [
    'あなた是澳大利亚学生签证材料清单的专业中英翻译引擎。'.replace('あなた', '你'),
    '任务：把官网材料清单条目翻译成简体中文，供中国申请人阅读。',
    '',
    '规则：',
    '1. 中文为主，官方术语按下方术语表保留英文括注，术语表之外的专有名词首次出现时附英文原文；',
    '2. 忠实原文，不增删内容、不给出任何建议性表述；',
    '3. 输出严格遵循给定 JSON schema；translations 数组与输入条目一一对应、等长等序。',
    '',
    '术语表（必须逐字使用中文定译）：',
    glossaryLines,
  ].join('\n');
}

/** 分类兜底专用 system 模板（Codex 外门 P2：不得复用翻译模板——指令自相矛盾） */
export function buildClassifySystemPrompt(): string {
  const glossaryLines = GLOSSARY.map(([en, zh]) => `- ${en} → ${zh}`).join('\n');
  return [
    '你是澳大利亚学生签证材料清单的章节归类引擎。',
    '任务：为官网清单中未命中确定性映射表的章节名，从给定候选分类中选出最合适的一个。',
    '',
    '规则：',
    '1. 只依据章节名语义选择，不臆测章节内容；',
    '2. category 字段必须逐字等于候选分类之一，不得创造新分类；',
    '3. 输出严格遵循给定 JSON schema。',
    '',
    '背景术语表（帮助理解章节名，不用于输出）：',
    glossaryLines,
  ].join('\n');
}

export const translateSchema = z.object({
  translations: z.array(z.string()),
});
export type TranslateOutput = z.infer<typeof translateSchema>;

export const classifySchema = z.object({
  category: z.string(),
});
export type ClassifyOutput = z.infer<typeof classifySchema>;

/** 设置页「测试」按钮的最小连接测试 schema */
export const pingSchema = z.object({
  pong: z.boolean(),
});

export function translateUserPrompt(items: string[]): string {
  return [
    '把以下 JSON 数组中的每个英文条目翻译成简体中文，返回等长的 translations 数组：',
    JSON.stringify(items),
  ].join('\n');
}

export function classifyUserPrompt(sectionName: string, categories: string[]): string {
  return [
    '以下是澳大利亚学生签证材料清单中的一个章节名。从给定分类中选择最合适的一个，返回 category 字段（必须逐字等于给定分类之一）。',
    `章节名：${JSON.stringify(sectionName)}`,
    `可选分类：${JSON.stringify(categories)}`,
  ].join('\n');
}

/** zod → JSON Schema，并递归强制对象 strict（additionalProperties:false + required 全字段） */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  enforceStrict(json);
  return json;
}

function enforceStrict(node: unknown): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (obj.type === 'object' && obj.properties && typeof obj.properties === 'object') {
    obj.additionalProperties = false;
    obj.required = Object.keys(obj.properties as Record<string, unknown>);
  }
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) value.forEach(enforceStrict);
    else enforceStrict(value);
  }
}
