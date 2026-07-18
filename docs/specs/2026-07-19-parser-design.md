# #5 parser — 清单 HTML 解析 — 设计文档

- 日期：2026-07-19 ｜ Issue：[#5](https://github.com/AlvinShenSSW/VisaPaw/issues/5)

## 官网 DOM 事实（快照实测）

- `div#<Type>` → `.accordion-item`×N；每 item：`.header-text h3`（章节名）+ `.collapse[id]`（内容，如 `div_Regular_Identity`）
- 章节数：**Regular 15 / Streamlined 13 / Undetermined 15**（SPEC §3 已修正，「16」不成立）
- 章节名含零宽字符（U+200B）与 `&nbsp;`；`<br/>` 混入（Undetermined 的 h3）——必须归一化
- 内容块：`<p>` 与 `<li>`（7 个 ul/32 个 li in Regular）；内联 `<a href>`（相对路径）

## API（`electron/parser.ts`）

```ts
parseChecklist(html, type: 'Regular'|'Streamlined'|'Undetermined') → ChecklistSection[]
ChecklistSection { name; anchorId: string|null; items: ChecklistItem[] }
ChecklistItem { text; links: {text, href}[] }   // href 绝对化到官网域
```

- 条目 = `.collapse` 内每个非空 `<p>` / `<li>`；嵌套 `<ul>` 的父 `<li>` 文本剔除子列表（子 li 单独成条）
- 归一化：去零宽（U+200B/200C/200D/FEFF）、NBSP→空格、空白折叠、trim——**#6 映射键以此输出为对齐基准**
- 空章节 → `items: []`；目标 div 缺失或 0 章节 → 抛错（与 fetcher 指纹互补）
- 保留官网原文文本与条目内链接（结果页「官网原文 ↗」用，mockups/03）

## 测试

快照三清单全量（15/13/15 + 精确章节名 + anchorId + 链接绝对化）；合成 HTML 边界：空章节、嵌套列表、a 内联、纯链接段落、div 缺失。
