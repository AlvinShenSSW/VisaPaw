# #7 annotator — 备注规则引擎 R1–R3 — 设计文档

- 日期：2026-07-19 ｜ Issue：[#7](https://github.com/AlvinShenSSW/VisaPaw/issues/7)

## 语义（SPEC §6 + F4 决议）

- 确定性规则引擎，**不走 LLM**；中文固定文案**不经翻译管道**，与 SPEC §6 逐字一致
- 触发器类型显式声明（F4）：`all`（对所有材料项生效）/ `keyword`（条目文本大小写不敏感命中任一关键词）
- R2 触发 = `all`（F4 决议定死；文案本身自带「非英文材料须附…」条件语义）
- 覆盖关系数据化：`overrides: ['R2']`——R3 触发时移除 R2（R1 不受影响 → 无犯罪条目 = R1+R3，PR #17 决议同步 #13 状态 D）
- 规则表 JSON 可配置：`parseRules(json)` 用 zod 校验，新增规则不改代码；默认表 `DEFAULT_RULES` 即配置的内置实例
- `level: normal | warning`——UI 分层驱动（普通=灰底小签、warning=红色警告条，#11 消费）

## API

`annotateItem(itemText, rules?) → AnnotationNote[]{ruleId, note, level}`（顺序按规则表；覆盖后输出）
`parseRules(json) → AnnotationRule[]`（校验失败抛错，附路径）

## 测试

表驱动：R2 正例（普通条目 R1+R2）/ R3 覆盖例（四种关键词变体逐一 → 仅 R1+R3）/ 文案逐字断言 / JSON 配置新增规则生效 / 非法配置拒绝 / 覆盖仅在覆盖者触发时生效。
