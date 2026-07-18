# #6 classifier — 确定性映射表 + AI 兜底 — 设计文档

- 日期：2026-07-19 ｜ Issue：[#6](https://github.com/AlvinShenSSW/VisaPaw/issues/6)

## 决议汇总（issue 评论）

- 映射键与 parser 抽取名**逐字对齐**（三套清单 15/13/15 全覆盖）；归一化 = 小写 + 空白折叠（大小写变体 `Migration agent/Agent` 由此吸收）
- `Special categories` **确定性映射**到教育与工作背景类，不走 AI 兜底（PR #17 决议）
- **F6 无 AI 降级**：AI 兜底失败（含全部 provider 失败/断网）→ 归入「待人工归类」，`autoClassified` 必须为 false，仍触发「映射表需更新」告警——分类兜底绝不阻断主流程（记录决策：分类的 AI 错误一律吞掉降级，与翻译的 network 直抛语义不同，因为分类有确定性降级出路而翻译没有）

## 结构

`electron/classifier.ts`：
- `CATEGORIES`：SPEC §5 七大分类常量（品行类无章节级映射键——它由 #7 的条目级规则驱动，保留分类名供 UI/导出）
- `SECTION_CATEGORY_MAP`：配置常量（不硬编码在解析逻辑），键为快照精确章节名
- `classifySections(names, deps)` → `ClassifiedSection[]{name, category, autoClassified, pendingManual}`
  - 命中 → `{category, autoClassified: false}`
  - 未命中 → 发 `mapping-outdated` 告警事件（#15 日志，兼官网改版探测器）→ AI 兜底（#8 `classifySection`，候选=七大分类）→ `{category, autoClassified: true}` + meta
  - AI 失败 → `{category: '待人工归类', pendingManual: true}` + `manual-pending` 事件

## 测试

快照集成：parser 解析三套清单 → 全部章节命中确定性映射（0 未命中、0 AI 调用）；大小写变体；未知章节走 AI（候选与事件断言）；AI 失败 → 待人工归类（不标 autoClassified）；映射表覆盖 SPEC §5 全部章节。
