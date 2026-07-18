/*
 * 备注规则引擎（SPEC §6）——确定性注入，不走 LLM（AGENTS 红线 3）；
 * 中文固定文案不经翻译管道，与 SPEC §6 逐字一致。
 * F4 决议：触发器类型显式声明（all / keyword），规则表 JSON 可配置，新增规则不改代码。
 */

import { z } from 'zod';

const triggerSchema = z.union([
  z.object({ type: z.literal('all') }),
  // 关键词须含非空白字符——空串会 includes() 命中一切，把条件规则变成全量规则（Codex 外门 P2）
  z.object({ type: z.literal('keyword'), keywords: z.array(z.string().trim().min(1)).min(1) }),
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

/** 自覆盖与覆盖环会静默吞掉合规备注——配置期拒绝（Kimi 终审 P2） */
function assertNoOverrideCycles(rules: Array<z.infer<typeof ruleSchema>>): void {
  const edges = new Map<string, string[]>(rules.map((r) => [r.id, r.overrides ?? []]));
  for (const r of rules) {
    if ((r.overrides ?? []).includes(r.id)) {
      throw new Error(`备注规则配置不合法：规则 ${r.id} 覆盖自身`);
    }
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const walk = (id: string, path: string[]): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`备注规则配置不合法：覆盖关系成环（${[...path, id].join(' → ')}）`);
    }
    visiting.add(id);
    for (const next of edges.get(id) ?? []) walk(next, [...path, id]);
    visiting.delete(id);
    done.add(id);
  };
  for (const r of rules) walk(r.id, []);
}

export type AnnotationRule = z.infer<typeof ruleSchema>;

export interface AnnotationNote {
  ruleId: string;
  note: string;
  level: 'normal' | 'warning';
}

/** 递归冻结——默认规则表被外部改写会污染全部后续调用（Kimi 终审 P2） */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** 内置规则表（SPEC §6 文案逐字）——本身就是一份合法配置实例，深度冻结 */
export const DEFAULT_RULES: readonly AnnotationRule[] = deepFreeze([
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
]);

/** JSON 配置 → 规则表（zod 校验，失败抛错并带路径）——新增规则不改代码 */
export function parseRules(json: unknown): AnnotationRule[] {
  const result = rulesSchema.safeParse(json);
  if (!result.success) {
    throw new Error(`备注规则配置不合法：${result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}`);
  }
  assertNoOverrideCycles(result.data);
  return result.data;
}

function triggered(rule: AnnotationRule, itemText: string): boolean {
  if (rule.trigger.type === 'all') return true;
  // 固定 en locale——避免宿主区域设置（如土耳其语 İ/i）影响英文关键词匹配（Kimi 终审 minor）
  const haystack = itemText.toLocaleLowerCase('en');
  return rule.trigger.keywords.some((k) => haystack.includes(k.toLocaleLowerCase('en')));
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
