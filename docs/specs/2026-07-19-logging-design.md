# #15 logging — 生成日志管道 — 设计文档

- 日期：2026-07-19 ｜ Issue：[#15](https://github.com/AlvinShenSSW/VisaPaw/issues/15)

## 形态

`electron/logging.ts`：`createLogStore(dir, {now, maxRuns=50})`——按「运行」一文件（`userData/logs/run-*.json`，0600 原子写）；`startRun(params)` 返回 RunHandle（`log(level, stage, message, durationMs?)` / `finish(status)`）。参数摘要仅 国籍·CRICOS·类型码——**无个人信息可写入**（红线 2，测试扫描断言）。

- 级别 `info/ok/warn/err` 与阶段 `判定/抓取/解析/分类/备注/翻译/完成/失败` 逐字对齐 mockups/04 日志窗口
- `listRuns/getRun/exportRun/clear`——IPC（`logs:*`）+ preload 桥供 #12 消费；导出为 mockup 同构文本行（`HH:mm:ss.SSS [级别|阶段] 消息（耗时)`）
- 事件桥：`aiEventToLog`（#8 AiEvent——fallback 行含**前后 provider + 错误原因**，orchestrator 补 `next` 字段）与 `classifierEventToLog`（#6——映射告警/自动归类/待人工）
- 超量运行按 startedAt 淘汰（默认保留 50）；损坏文件跳过不炸

## 测试

一次成功生成的完整阶段链路（单测）；fallback 事件前后 provider 与原因；持久化文件 PII 扫描（合成敏感词 0 命中）；导出格式；清空/淘汰/损坏自愈；orchestrator `next` 计算。
