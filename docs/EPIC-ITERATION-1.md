# VisaPaw Iteration 1 — Epic 与 Issues

> 本文档为 GitHub Epic 与全部子 issue 的正文，供批量创建使用。
> 依据：`docs/SPEC.md` v0.2、`AGENTS.md`、`mockups/`（高保真 UI/UX 稿，2026-07-19 定稿）。
> **编号说明**（创建后追记）：文中「Issue N」为文档序号；实际创建后 Epic = GitHub #1，文档 Issue N = GitHub **#N+1**（对照表见 GitHub Epic #1 评论）。SPEC v0.3 起的修订以 GitHub 编号引用。
> **设计红线：所有 UI 相关工作严格按照 `mockups/` 下的 UI/UX 稿实现——布局、配色 token、字体层级、组件状态（含浅色/深色模式）以 mockup 为唯一视觉验收基准，不得自行发挥。**

---

## Epic

**标题**：`[Epic] Iteration 1 — Subclass 500 完整链路（三步向导：输入 → 生成 → 结果 → 导出）`
**Labels**：`epic`
**正文**：

Mac 桌面 App（Electron + React + TypeScript）：三步向导——① 选择护照国籍 / 意向院校 / 学生类型 → ② 实时检索移民局官网 Document Checklist Tool 并翻译成中文 → ③ 中英双语对照清单（七大分类 + 合规备注），导出 Markdown / PDF / 剪贴板。细粒度执行过程记录到 设置 → 日志。

**范围**（SPEC §2）：仅 Subclass 500；多 AI Provider（Claude / ChatGPT / MiMo）按序 fallback；不做多申请人档案、不做其他签证类别、永不做云端抓取代理。

**流程修订**（相对 SPEC v0.2，已体现在 mockups 中）：
- Step 1 仅保留官网工具三字段（Country of passport / Education provider / Student type），**移除姓名字段**，文档标题不含姓名，App 全程不采集个人信息；
- 原「生成进度视图」降为轻量 Step 2（搜索官网清单 → 翻译成中文两阶段 + provider/fallback 提示）；
- 判定 / 抓取 / 解析 / 分类 / 备注注入等细粒度过程写入 设置 → 日志。

**硬约束红线**（AGENTS.md，违反即 review 不通过）：
1. 官网抓取只能从用户本机直连（官网封数据中心 IP），禁止云端代理；
2. 发给 AI 的只能是官网公开清单文本，不涉及任何个人信息；
3. 合规备注由确定性规则引擎注入（R1–R3），不交给 LLM 生成；
4. 分类先走确定性映射表，AI 只兜底且必须标注「自动归类」；
5. 每份文档必须带：抓取时间、清单类型（Regular/Streamlined/Undetermined）、免责声明；
6. **设计严格按照 `mockups/` 的 UI/UX 稿实现，mockup 是唯一视觉验收基准。**

**子任务**：创建完成后在此处维护 task list（`- [ ] #编号`）。

---

## Issue 1

**标题**：`docs: 按三步向导修订 SPEC（§4 流程 / §7 标题 / §9 隐私 / §8 日志）`
**Labels**：`docs`
**正文**：

依据 mockups 定稿把流程修订写回 `docs/SPEC.md`：

- §4：主流程改为三步向导；「生成进度」相关描述改为轻量两阶段视图，细粒度进度移入 设置 → 日志；
- §7：标题格式去掉 `〈姓名〉` 前缀，改为「澳大利亚学生签证（Subclass 500）申请材料清单」；
- §9：隐私条款收紧为「App 不采集任何个人信息」（原为姓名仅本地拼接）；
- §8 / Renderer 清单：设置页增加「日志」标签（生成日志：判定/抓取/解析/分类/备注/翻译/fallback 事件，仅存本机，可导出/清空）；
- 同步更新 `AGENTS.md` 对应条目（红线 2 改为「不涉及个人信息」、Renderer 组成）。

**验收标准**
- [ ] SPEC 与 AGENTS.md 与 `mockups/index.html`「流程修订」一节一致；
- [ ] 免责声明、抓取时间、清单类型三要素条款保持不变。

---

## Issue 2

**标题**：`chore: Electron + React 骨架与 macOS 视觉基线（复用 BookingPro desktop/）`
**Labels**：`chore`
**正文**：

按 AGENTS.md 架构基线搭壳：electron-builder、`electron/main.ts` + `preload.ts`、React renderer、`credential-store.ts`（Keychain）、`settings-store.ts`；抓取/解析/规则引擎/AI 调用全部在 main process，renderer 经 IPC 通信；不需要 MCP server 层。

同时落地全局视觉基线（严格按 mockups 设计说明）：
- 设计 token：天蓝 `#2E9BDF`（深色 `#4FB0F0`）/ 浅灰 `#F5F7FA` `#E9EDF2` / 白 `#FFFFFF`，功能色仅琥珀（降级/配额告警）与红（R3 警告/错误）；
- 系统字体栈 `-apple-system / PingFang SC`，正文 13–14.5px，数字 tabular-nums；
- 浅色/深色模式跟随系统（CSS 变量 + `prefers-color-scheme`）；
- 窗口 chrome、标题栏、状态栏样式与 mockups 一致。

**验收标准**
- [ ] `npm run dev` 可启动窗口，深浅色自动切换；
- [ ] 设计 token 以单一文件维护，各页面引用，不散落硬编码；
- [ ] 视觉与 `mockups/01`–`05` 的窗口 chrome / 配色 / 字体层级一致。

---

## Issue 3

**标题**：`feat(fetcher): 官网数据抓取层 + 结构指纹校验`
**Labels**：`feat`, `scraper`
**正文**：

main process `fetcher` 模块（技术事实见 AGENTS.md「关键技术事实」，均已实测）：

- Termstore 接口拉取国家（`CountriesOfPassport`）与院校（`CRICOS`）下拉数据，**缓存 7 天**；
- `GetStudentDocumentChecklistType` 判定 Regular / Streamlined / Undetermined；
- `GET /visas/web-evidentiary-tool` 抓取清单页（约 1.4MB），每次生成实时抓取；
- 请求头：浏览器 UA + `Content-Type: application/json`；
- **结构指纹校验**：启动/生成前校验三个清单 div 与两个接口关键字段存在，失效抛特定错误供降级（见 Issue 12）；
- 错误分三类并可区分：网络失败 / HTTP 403 / 结构变化（供 UI 分别呈现）；
- 单用户低频请求，禁止批量并发。

**验收标准**
- [ ] 三个端点均有单测（fixture 回放）；
- [ ] CHN + 未定院校 → Streamlined 的实测路径通过；
- [ ] 403 与网络超时抛出不同错误类型；
- [ ] 红线：仅本机直连，无任何代理配置项。

---

## Issue 4

**标题**：`feat(parser): 清单 HTML 解析为结构化条目`
**Labels**：`feat`, `scraper`
**正文**：

cheerio 解析 `div#Regular` / `div#Streamlined` / `div#Undetermined` → `{section, items[], links[]}`；保留官网原文与条目内链接（结果页「官网原文 ↗」跳转用，见 `mockups/03`）。

**验收标准**
- [ ] 以官网真实快照做 fixture，Regular 版解析出 16 个章节（Identity / Evidence of intended study / Financial capacity / OSHC / Form 956 等，见 SPEC §3）；
- [ ] 空章节、嵌套列表、a 标签内联等边界有测试；
- [ ] 输出结构含官网原文文本，供双语对照展示。

---

## Issue 5

**标题**：`feat(classifier): 确定性映射表 + AI 兜底归类`
**Labels**：`feat`
**正文**：

- 官网章节 → 七大中文分类的映射表（SPEC §5），以 JSON/TS 常量配置维护，不硬编码在解析逻辑；
- 未命中章节走 AI 兜底（复用 Provider 层，Issue 7），结果打 `autoClassified: true`；
- 兜底同时触发「映射表需更新」告警（写入日志，兼作官网改版探测器）；
- UI 呈现：结果页条目带「✦ 自动归类」标注 + 人工复核提示（样式严格按 `mockups/03-result.html` 第 5 条示例）。

**验收标准**
- [ ] SPEC §5 表内全部章节命中正确分类（单测）；
- [ ] 兜底条目在导出文档（MD/PDF）中同样带「自动归类」标注；
- [ ] 红线：映射优先，AI 仅兜底。

---

## Issue 6

**标题**：`feat(annotator): 备注规则引擎 R1–R3（JSON 可配置）`
**Labels**：`feat`
**正文**：

确定性规则引擎（SPEC §6），**不走 LLM**，中文固定文案不经翻译管道：

- R1 所有材料：「彩色扫描件，四角齐全，清晰可读」；
- R2 证件/证明类：「非英文材料须附宣誓翻译（certified translation）或公证翻译件」；
- R3 命中 police check / police certificate / penal clearance / 无犯罪：「⚠️ 无犯罪记录证明如原件非英文，只能使用公证处出具的公证翻译件，不接受宣誓翻译」，**R3 覆盖 R2**；
- 规则表 JSON 配置，新增规则不改代码。

**验收标准**
- [ ] R3 覆盖 R2 的优先级有单测（无犯罪条目只出 R1+R3）；
- [ ] UI 分层严格按 `mockups/03`：普通备注灰底小签、R3 红色系高对比警告条；
- [ ] 文案与 SPEC §6 逐字一致。

---

## Issue 7

**标题**：`feat(ai): AI Provider 层——Claude / ChatGPT / MiMo，按序 fallback，Keychain`
**Labels**：`feat`, `ai-provider`
**正文**：

按 SPEC §8 / AGENTS.md 约定实现 `translator` 与兜底归类共用的 Provider 层：

- Claude：`@anthropic-ai/sdk`，默认 `claude-opus-4-8`，可切 `claude-sonnet-5`，结构化输出 `output_config.format`，术语表 system prompt + prompt caching；
- ChatGPT：`openai` SDK，`response_format: json_schema`；
- MiMo：`openai` SDK + baseURL 覆写，`mimo-v2.5-pro` / `mimo-v2.5`，**Token Plan 配额错误必须视为可 fallback 错误**；
- fallback 触发：401/403、429、套餐/配额耗尽、5xx、结构化输出解析重试一次仍失败；网络完全不可用不 fallback 直接报错；
- 翻译走结构化 JSON（zod schema）：条目数组进 → **等长**译文数组出；
- 术语表（CoE=入学确认书、OSHC=海外学生健康保险、GS=真实学生要求、CRICOS、Form 956/956A…）三家共用同一 prompt 模板；
- 所有 key 存 macOS Keychain，按 provider 命名空间隔离；
- 每次生成的结果元信息记录实际使用的 provider 与模型；fallback 事件写日志（Issue 14）。

**验收标准**
- [ ] mock 三家 API 的 fallback 链路单测（含 MiMo 配额耗尽 → 下一家）；
- [ ] 等长校验失败重试一次、再失败触发 fallback 的路径有测试；
- [ ] 红线：请求体中不含任何个人信息（仅官网清单文本）。

---

## Issue 8

**标题**：`feat(ui): Step 1 — 填写申请信息（mockups/01）`
**Labels**：`feat`, `ui`
**正文**：

**UI 严格按 `mockups/01-input-form.html` 实现**（布局/配色/字体层级/状态，含深色模式）：

- 三步向导指示器（① 填写申请信息 ② 生成清单 ③ 查看结果）；
- 护照国籍：combobox，**可下拉选择也可输入搜索**（本地模糊过滤，↑↓ 选择回车确认，高亮匹配段）；
- 意向院校：同款 combobox，支持名称模糊搜索 / 直接输入 CRICOS 码，下拉列表末尾固定「未定」选项（按「未列出院校」判定）；
- 学生类型：下拉，默认「普通学生 — 01」，含 02–05 全部选项；
- 主按钮「生成清单 →」；隐私说明文案与状态栏（官网可达性 + 当前 provider 链）按 mockup；
- 下拉数据来自 Issue 3 的 Termstore 缓存。

**验收标准**
- [ ] 与 mockup 逐像素级对照通过（浅色 + 深色）；
- [ ] 模糊搜索为纯本地过滤，无网络请求；
- [ ] 键盘可完整操作（Tab / ↑↓ / Enter / Esc）。

---

## Issue 9

**标题**：`feat(ui): Step 2 — 生成清单轻量视图（mockups/02）`
**Labels**：`feat`, `ui`
**正文**：

**UI 严格按 `mockups/02-progress.html` 实现**，两个状态：

- 状态 A「正在搜索 Document Checklist Tool…」：大 spinner + 三个参数 chip + 两阶段列表（搜索官网材料清单 → 翻译成中文）；
- 状态 B「正在翻译成中文…」：标注当前 provider（如 `Claude · claude-opus-4-8`）、清单摘要（类型 + 章节/条目数）、翻译进度条（n/34）；
- fallback 提示条：「MiMo 套餐额度已用尽，已自动切换至 Claude…」（琥珀色，按 mockup）；
- 底部「详细执行过程记录于 设置 → 日志」链接 + 取消按钮；
- 进度事件经 IPC 流式推送；细粒度事件不在此展开（写日志，Issue 14）。

**验收标准**
- [ ] 与 mockup 两状态一致（浅色 + 深色）；
- [ ] 取消可中断当前生成且不留悬挂请求；
- [ ] fallback 发生时提示条实时出现。

---

## Issue 10

**标题**：`feat(ui): Step 3 — 结果视图：中英双语清单（mockups/03，核心页）`
**Labels**：`feat`, `ui`
**正文**：

**UI 严格按 `mockups/03-result.html` 实现**，这是产品核心页：

- 标题「澳大利亚学生签证（Subclass 500）申请材料清单」（本地拼接，不经 AI）；
- 元信息：清单类型徽章（Streamlined/Regular/Undetermined）、护照国籍、院校（含 CRICOS）、学生类型、数据来源、**抓取时间**、实际使用的 AI provider；
- 七大中文分类分组（分类色条 + 英文章节副标 + 条数）；
- 每条材料：中文为主行，官方术语蓝色括注保留英文（CoE、OSHC、GS、Form 956…）；「英文原文」逐条折叠展开（左蓝边引用样式 + 官网原文链接），标题栏「展开全部英文 / 收起全部英文」全局开关；
- 备注分层：普通备注（R1/R2）灰底小签；R3 警告红色高对比条；「✦ 自动归类」标注条目按 mockup；
- **底部固定 dock：免责声明（不可省略）+ 导出 Markdown / 导出 PDF / 复制到剪贴板**；
- 「重新生成」入口在标题栏。

**验收标准**
- [ ] 与 mockup 逐项对照通过（浅色 + 深色）；
- [ ] 红线三要素（抓取时间 / 清单类型 / 免责声明）任何状态下不缺失；
- [ ] 长清单滚动时底部 dock 固定，展开全部英文性能无卡顿。

---

## Issue 11

**标题**：`feat(ui): 设置页 — Provider 管理 + 日志标签（mockups/04）`
**Labels**:`feat`, `ui`, `ai-provider`
**正文**：

**UI 严格按 `mockups/04-settings.html` 实现**：

- macOS 风格设置标签栏：通用 / AI Provider / 日志 / 数据缓存 / 关于；
- AI Provider 标签：三家 provider 卡片（Claude / ChatGPT / MiMo），各含 API key（掩码显示 + 更换/验证）、启用开关（macOS toggle）、模型选择；**拖拽手柄 ⠿ + 顺序编号**决定 fallback 顺序；状态 pill（可用 / 套餐额度已用尽 / 未启用）；MiMo 卡片 Token Plan 警示文案；底部 Keychain 安全提示条；
- 日志标签：历史运行下拉（时间 · 类型 · 结果）、逐条带毫秒时间戳的记录（判定/抓取/解析/分类/备注/翻译/fallback），日志级别着色（info 蓝 / ok 绿 / warn 琥珀 / err 红，等宽字体），导出日志 / 清空按钮；数据源为 Issue 14。

**验收标准**
- [ ] 与 mockup 两个标签页一致（浅色 + 深色）；
- [ ] 拖拽排序实时生效并持久化到 settings-store；
- [ ] key 只写 Keychain，settings 文件中无明文。

---

## Issue 12

**标题**：`feat(ui): 异常与降级状态（mockups/05）`
**Labels**：`feat`, `ui`
**正文**：

**UI 严格按 `mockups/05-errors.html` 实现**，四个状态：

- A 网络失败：明确文案 + 重试按钮 + 错误代码（NET_TIMEOUT），注明未消耗 AI 额度；
- B 官网 403：**与网络失败文案分开**——说明数据中心 IP / VPN / 公司代理场景，引导切换住宅网络后重试；
- C 结构指纹校验失败：降级为内嵌 WebView 打开官网手动模式 + 顶部琥珀色「App 需要更新」提示条（检查更新 / 重试自动解析）；
- D 所有 provider 翻译失败：保留英文清单展示（分类与备注仍注入），顶部局部提示「翻译暂不可用，可重试翻译」（重试不重新抓取）；元信息三要素仍完整。

**验收标准**
- [ ] 四状态与 mockup 一致（浅色 + 深色）；
- [ ] 三类错误由 fetcher 的错误类型驱动，不靠字符串匹配；
- [ ] 状态 D 单独重试翻译成功后无缝进入完整结果视图。

---

## Issue 13

**标题**：`feat(export): 导出 Markdown / PDF / 剪贴板`
**Labels**：`feat`
**正文**：

- Markdown：按 SPEC §7 文档结构（标题、元信息行、七大分类编号、备注、免责声明）；
- PDF：Electron `webContents.printToPDF` 渲染专用打印模板（无额外依赖），排版延续结果页设计语言（分类色条、备注分层、R3 警告样式的打印适配）；
- 剪贴板：纯文本 + Markdown 两种格式；
- 三种导出均包含：抓取时间、清单类型、免责声明、实际 provider、自动归类标注（红线）。

**验收标准**
- [ ] 三种导出内容与结果视图逐条一致（快照测试）；
- [ ] PDF 分页不截断单条材料，中文字体渲染正常；
- [ ] 红线三要素在任何导出物中不可省略。

---

## Issue 14

**标题**：`feat(logging): 生成日志管道（main process → 设置页日志）`
**Labels**：`feat`
**正文**：

- pipeline 各阶段（判定 / 抓取 / 解析 / 分类 / 备注 / 翻译 / fallback / 完成或失败）发结构化日志事件：毫秒时间戳、级别（info/ok/warn/err）、阶段、消息、耗时；
- 按「运行」分组存储于本机（含输入参数摘要 CHN · CRICOS · 类型码、总耗时、结果状态），不含任何个人信息；
- 「映射表需更新」告警（Issue 5）与 MiMo 配额耗尽等 fallback 事件（Issue 7）必须入日志；
- 提供 IPC 查询接口供设置页日志标签（Issue 11）消费；支持导出（文本文件）与清空；
- 日志条目格式与着色语义严格按 `mockups/04-settings.html` 日志窗口示例。

**验收标准**
- [ ] 一次成功生成产生完整阶段链路日志（单测）；
- [ ] fallback 事件包含前后 provider 与错误原因；
- [ ] 日志文件中检索不到任何个人信息字段。

---

## 建议的依赖关系（创建后用 issue 引用注明）

- Issue 2 → 为 8/9/10/11/12 的前置；
- Issue 3 → 4 → 5/6 → 10；Issue 3 为 8（下拉数据）与 12（错误类型）前置；
- Issue 7 → 5（AI 兜底）、9（fallback 提示）、11（Provider 设置）前置；
- Issue 14 → 11（日志标签数据源）前置；
- Issue 13 依赖 10 的数据结构。
