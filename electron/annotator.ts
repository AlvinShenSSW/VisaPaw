/*
 * 备注规则引擎（SPEC §6）——确定性注入，不走 LLM（AGENTS 红线 3）；
 * 中文固定文案不经翻译管道，与 SPEC §6 逐字一致。
 * F4 决议：触发器类型显式声明（all / keyword），规则表 JSON 可配置，新增规则不改代码。
 */

import { z } from 'zod';

const triggerSchema = z.union([
  z.object({ type: z.literal('all') }),
  z.object({ type: z.literal('keyword'), keywords: z.array(z.string()).min(1) }),
]);

const ruleSchema = z.object({
  id: z.string().min(1),
  trigger: triggerSchema,
  note: z.string().min(1),
  /** normal = 灰底小签；warning = 红色高对比警告条（mockups/03 分层，#11 消费） */
  level: z.enum(['normal', 'warning']),
  /** 触发时移除这些规则的备注（如 R3 覆盖 R2；R1 不受影响） */
  overrides: z.array(z.string()).optional(),
});

const rulesSchema = z.array(ruleSchema).min(1);

export type AnnotationRule = z.infer<typeof ruleSchema>;

export interface AnnotationNote {
  ruleId: string;
  note: string;
  level: 'normal' | 'warning';
}

/** 内置规则表（SPEC §6 文案逐字）——本身就是一份合法配置实例 */
export const DEFAULT_RULES: readonly AnnotationRule[] = [
  {
    id: 'R1',
    trigger: { type: 'all' },
    note: '彩色扫描件，四角齐全，清晰可读',
    level: 'normal',
  },
  {
    id: 'R2',
    // F4 决议：默认对所有材料项生效（文案自带「非英文材料」条件语义）
    trigger: { type: 'all' },
    note: '非英文材料须附宣誓翻译（certified translation）或公证翻译件',
    level: 'normal',
  },
  {
    id: 'R3',
    trigger: {
      type: 'keyword',
      keywords: ['police check', 'police certificate', 'penal clearance', '无犯罪'],
    },
    note: '⚠️ 无犯罪记录证明如原件非英文，只能使用公证处出具的公证翻译件，不接受宣誓翻译',
    level: 'warning',
    overrides: ['R2'],
  },
];

/** JSON 配置 → 规则表（zod 校验，失败抛错并带路径）——新增规则不改代码 */
export function parseRules(json: unknown): AnnotationRule[] {
  const result = rulesSchema.safeParse(json);
  if (!result.success) {
    throw new Error(`备注规则配置不合法：${result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}`);
  }
  return result.data;
}

function triggered(rule: AnnotationRule, itemText: string): boolean {
  if (rule.trigger.type === 'all') return true;
  const haystack = itemText.toLowerCase();
  return rule.trigger.keywords.some((k) => haystack.includes(k.toLowerCase()));
}

/** 对单条材料注入备注：先算触发集，再应用覆盖，输出按规则表顺序 */
export function annotateItem(
  itemText: string,
  rules: readonly AnnotationRule[] = DEFAULT_RULES
): AnnotationNote[] {
  const active = rules.filter((r) => triggered(r, itemText));
  const suppressed = new Set(active.flatMap((r) => r.overrides ?? []));
  return active
    .filter((r) => !suppressed.has(r.id))
    .map((r) => ({ ruleId: r.id, note: r.note, level: r.level }));
}
