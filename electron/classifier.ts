/*
 * 分类器——确定性映射表优先，AI 只兜底（AGENTS 红线 4）。
 * 映射键与 parser 归一化输出逐字对齐（三套清单快照 15/13/15 全覆盖，#5/#6 决议）；
 * 查找时小写 + 空白折叠，吸收官网大小写变体（Migration agent / Agent）。
 * F6 决议：AI 兜底失败 → 「待人工归类」，不标 autoClassified，主流程不阻断。
 */

import type { AiMeta } from './ai/orchestrator.ts';

export const CATEGORIES = [
  '个人身份类',
  '教育与工作背景类',
  '资金财务类',
  '健康与保险类',
  '品行类',
  '家庭成员与监护类',
  '代理与授权类',
] as const;
export type CategoryName = (typeof CATEGORIES)[number];

/** F6 决议：无 AI 时未命中章节的降级分组（不得伪标「自动归类」） */
export const PENDING_MANUAL_CATEGORY = '待人工归类' as const;

/**
 * 官网章节 → 中文分类（SPEC §5，配置常量——不硬编码进解析逻辑）。
 * 键为 2026-07-19 快照的精确章节名（Regular 15 / Streamlined 13 / Undetermined 15 全覆盖）；
 * 「品行类」无章节级键——police check 相关由 #7 条目级规则驱动。
 */
export const SECTION_CATEGORY_MAP: Readonly<Record<string, CategoryName>> = {
  // 个人身份类
  Identity: '个人身份类',
  'Evidence of your identity': '个人身份类', // Undetermined 变体
  'Change of name': '个人身份类',
  // 教育与工作背景类
  'Evidence of intended study': '教育与工作背景类',
  'Special categories': '教育与工作背景类', // PR #17 决议：确定性映射，不走 AI
  'Evidence of English language ability': '教育与工作背景类',
  'Genuine Student requirement': '教育与工作背景类',
  'Employment history': '教育与工作背景类',
  'Research Students': '教育与工作背景类',
  // 资金财务类
  'Evidence of financial capacity': '资金财务类',
  // 健康与保险类
  'Health insurance': '健康与保险类',
  // 家庭成员与监护类
  'Welfare arrangements for under 18 year old student': '家庭成员与监护类',
  'Parental consent': '家庭成员与监护类',
  'Relationship - spouse, de facto partner': '家庭成员与监护类',
  'Evidence of school enrolment for dependants': '家庭成员与监护类',
  // 代理与授权类
  'Migration agent - Form 956 Advice by a migration agent/exempt person': '代理与授权类',
  'Appointment or withdrawal of an authorised recipient - Form 956A': '代理与授权类',
};

/** 归一化查找键：小写 + 空白折叠（#6 决议的归一化规则） */
function lookupKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

const NORMALIZED_MAP: ReadonlyMap<string, CategoryName> = new Map(
  Object.entries(SECTION_CATEGORY_MAP).map(([k, v]) => [lookupKey(k), v])
);

export interface ClassifiedSection {
  name: string;
  category: CategoryName | typeof PENDING_MANUAL_CATEGORY;
  /** true 仅当由 AI 兜底成功归类（UI「✦ 自动归类」标注 + 导出标注） */
  autoClassified: boolean;
  /** F6：AI 不可用时的待人工分组 */
  pendingManual: boolean;
  /** AI 兜底时记录实际 provider/模型 */
  aiMeta?: AiMeta;
}

export type ClassifierEvent =
  | { type: 'mapping-outdated'; section: string }
  | { type: 'auto-classified'; section: string; category: CategoryName; meta: AiMeta }
  | { type: 'manual-pending'; section: string; reason: string };

export interface ClassifierDeps {
  /** #8 orchestrator.classifySection；不传 = 无可用 AI（直接走待人工归类） */
  classifyWithAi?: (
    sectionName: string,
    categories: string[]
  ) => Promise<{ category: string; meta: AiMeta }>;
  onEvent?: (e: ClassifierEvent) => void;
}

export async function classifySections(
  sectionNames: string[],
  deps: ClassifierDeps = {}
): Promise<ClassifiedSection[]> {
  const emit = deps.onEvent ?? (() => undefined);
  const results: ClassifiedSection[] = [];

  for (const name of sectionNames) {
    const mapped = NORMALIZED_MAP.get(lookupKey(name));
    if (mapped) {
      results.push({ name, category: mapped, autoClassified: false, pendingManual: false });
      continue;
    }

    // 未命中：映射表需更新告警（#15 日志，兼官网改版探测器）
    emit({ type: 'mapping-outdated', section: name });

    if (deps.classifyWithAi) {
      try {
        const { category, meta } = await deps.classifyWithAi(name, [...CATEGORIES]);
        // orchestrator 已校验 category ∈ 候选；此处窄化类型
        const validated = CATEGORIES.find((c) => c === category);
        if (validated) {
          emit({ type: 'auto-classified', section: name, category: validated, meta });
          results.push({
            name,
            category: validated,
            autoClassified: true,
            pendingManual: false,
            aiMeta: meta,
          });
          continue;
        }
      } catch (e) {
        // F6：分类兜底的任何 AI 失败（含断网/全部 provider 失败）都降级——
        // 分类有确定性出路（待人工归类），与翻译的 network 直抛语义不同
        emit({ type: 'manual-pending', section: name, reason: (e as Error).message });
        results.push({
          name,
          category: PENDING_MANUAL_CATEGORY,
          autoClassified: false,
          pendingManual: true,
        });
        continue;
      }
    }

    emit({ type: 'manual-pending', section: name, reason: '无可用 AI provider' });
    results.push({
      name,
      category: PENDING_MANUAL_CATEGORY,
      autoClassified: false,
      pendingManual: true,
    });
  }

  return results;
}
