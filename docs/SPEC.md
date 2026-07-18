# VisaPaw 需求文档（Spec）

- 版本：v0.3（三步向导修订，依据 mockups 定稿）
- 日期：2026-07-19
- 状态：三个开放问题已确认（见 §12 决议记录）；流程修订已依据 `mockups/` 定稿写回（Issue #2），可进入开发

---

## 1. 背景与目标

申请澳大利亚签证时，澳洲移民局官网提供 [Document Checklist Tool](https://immi.homeaffairs.gov.au/visas/web-evidentiary-tool)（Web Evidentiary Tool）：选择护照国籍与教育机构后，返回该申请人应提交的官方材料清单。但该工具为英文、无分类整理、无中国申请人关心的翻译/公证合规提示，且每次都要手动操作网页。

**VisaPaw 的目标**：做一个 Mac 桌面 App（套壳架构，参照 BookingPro / TaskPaw），输入申请信息后一键完成——

1. 实时检索官网最新材料清单（保证时效性，不做静态快照）；
2. 自动翻译成中文（术语准确、双语可对照）；
3. 按材料类别整理（个人身份、教育工作背景、品行等）；
4. 每项材料注入合规备注（扫描件要求、翻译/公证要求）；
5. 生成带标题的交付文档：`澳大利亚学生签证（Subclass 500）申请材料清单`。

**目标用户**：申请澳洲学生签证的中国申请人及其家人/中介顾问。

## 2. 范围

### Iteration 1（本文档范围）

- 签证类别：**仅学生签 Subclass 500**（官网该工具本身只覆盖学生签）。
- 输入：护照国籍、意向院校（或 CRICOS 码，可选「未定」）、学生类型（默认普通学生）。**不采集申请人姓名等任何个人信息**（与官网工具的三个原生字段一一对应）。
- 输出：分类 + 翻译 + 备注 + 标题的清单文档（中英双语对照）；**Markdown 导出、PDF 导出、剪贴板复制**。
- AI Provider：设置页可添加多家 API key（Claude / ChatGPT / MiMo），多选启用并**按用户排序做 fallback**；key 全部存 Keychain。详见 §8。

### 明确不做（后续迭代）

- 其他签证类别（485/482/600 等，官网为各 visa listing 的静态页，解析器不同）→ Iteration 3
- 多申请人档案管理、清单勾选进度 → Iteration 2
- 官网清单变更监测与 diff 提醒 → Iteration 3
- 云端服务/账号体系：**永久不做云端抓取代理**（见 §9 约束）

## 3. 官网工具技术侦察（2026-07-19 实测）

页面为 SharePoint（ASP.NET WebForms）应用，前端逻辑在 `/AssetLibrary/dist/js/app.wet.js`。实测结论：

| # | 环节 | 方式 | 实测结果 |
|---|------|------|---------|
| 1 | 国家/院校下拉 | `POST /_layouts/15/api/Termstore.aspx/GetTermsByProperty`，`termSetName` = `CountriesOfPassport` 或 `CRICOS` | ✅ 返回 `{Key:名称, Value:代码}` 全量列表 |
| 2 | 清单类型判定 | `POST /_layouts/15/api/ESB.aspx/GetStudentDocumentChecklistType`，入参 `{countryPassport, provider, cricosCode, studentEvidenceStudyTypeCode}` | ✅ 返回 `Regular` / `Streamlined` / `Undetermined` 三值之一（CHN + 未定学校 → Streamlined） |
| 3 | 清单内容 | `GET /visas/web-evidentiary-tool`（约 1.4MB HTML），三套清单预渲染于 `div#Regular` / `div#Streamlined` / `div#Undetermined` | ✅ Regular 版约 48KB，16 个章节 |

- 无需浏览器自动化、无需 reCAPTCHA token；需浏览器 UA + `Content-Type: application/json`。
- ⚠️ 判定接口仅实测过「未定院校」入参（`provider:"NotListed"`、`cricosCode:" "`）；**选定院校时的入参映射（推测为 provider=Termstore Key、cricosCode=Termstore Value）待 fetcher（GitHub issue #4）落地时抓包实测确认并回填本节**，实测前不得当作事实实现；确认后 fetcher 需补选校路径的 fixture 测试。
- **官网对数据中心 IP 返回 403**，本机住宅 IP 正常 → 抓取必须在用户 Mac 上直连。
- 学生类型码：`01` 普通（默认）/ `02` 中学交换 / `03` PhD 论文评审续签 / `04` DFAT 资助 / `05` 国防部资助。

Regular 版清单章节（官网原始结构）：Identity / Evidence of intended study（含 Special categories）/ Welfare arrangements for under 18 / Parental consent / Health insurance / Financial capacity / English language ability / Genuine Student / Change of name / Relationship (spouse, de facto) / Employment history / Form 956 / Form 956A / Evidence of school enrolment for dependants / Research Students。

## 4. 用户故事与流程

> 作为一名申请澳洲学生签证的申请人，我输入我的国籍和想去的学校，就能得到一份中文的、分好类的、标注了扫描和翻译要求的官方材料清单，直接照着准备材料。

主流程（**三步向导**，依据 mockups 定稿修订）：

1. **Step 1 填写申请信息**：仅官网工具三个原生字段——护照国籍（可搜索下拉）、意向院校（可搜索下拉 / CRICOS 码 / 「未定」）、学生类型（默认 01）。不含姓名字段，不采集任何个人信息。
2. **Step 2 生成清单**（轻量两阶段视图）：点击「生成清单」后仅呈现两个阶段——「搜索官网材料清单」（判定接口 + 页面抓取 + 解析）→「翻译成中文」（标注当前 provider，fallback 时提示切换）；判定 / 抓取 / 解析 / 分类 / 备注注入等细粒度过程**写入 设置 → 日志**，不在此展开。
3. **Step 3 查看结果**：中英双语清单，顶部为标题与元信息（清单类型、抓取时间、免责声明），导出 Markdown / 导出 PDF / 复制到剪贴板。

异常流程：

- 官网 403 / 网络失败 → 明确报错并允许重试。
- 结构指纹校验失败（官网改版）→ 降级为内嵌 WebView 打开官网 + 提示等待 App 更新。WebView 仅加载官网基础 URL；官网页面无公开的预填查询参数，表单预填为 best-effort，默认由用户在官网表单中手动补全（含学生类型等已选项，UI 需展示用户此前的全部选择供其照抄）。WebView 安全约束：启用沙箱、导航限制在 `immi.homeaffairs.gov.au` 域内、不注入脚本、无读取表单内容的 preload（App 不采集个人信息的红线在降级模式同样成立）。
- AI provider 失败（认证失败 / 限流 / 套餐额度耗尽 / 服务端错误）→ 自动按顺序 fallback 到下一个已启用 provider，UI 标注实际使用的 provider；全部失败则保留英文清单结果，提示翻译暂不可用，可重试翻译环节。

## 5. 分类方案

**先查确定性映射表，AI 只兜底。** 官网章节 → 中文大类：

| 中文大类 | 官网章节 |
|---|---|
| 个人身份类 | Identity、Change of name |
| 教育与工作背景类 | Evidence of intended study、English language ability、Genuine Student (GS)、Employment history、Research Students |
| 资金财务类 | Evidence of financial capacity |
| 健康与保险类 | Health insurance (OSHC) |
| 品行类 | Police check / 无犯罪记录相关条目 |
| 家庭成员与监护类 | Welfare arrangements (under 18)、Parental consent、Relationship (spouse/de facto)、Dependants school enrolment |
| 代理与授权类 | Form 956、Form 956A |

- 映射表未命中的新章节：由 Claude 兜底归类，文档中标注「自动归类」，并触发「映射表需更新」告警（兼作官网改版探测器）。
- 映射表以配置文件（JSON/TS 常量）维护，不硬编码在解析逻辑里。
- 上表章节名为简写；**映射键必须与 parser 从官网快照实际抽取的章节名逐字对齐**（如 `Welfare arrangements for under 18`、`Evidence of school enrolment for dependants`），归一化规则（trim/大小写/空白折叠）在 classifier（GitHub issue #6）中定义并对 §3 全部章节做覆盖测试；`Special categories` 随父章节归入教育与工作背景类，不走 AI 兜底。
- ⚠️ `mockups/03-result.html` 第 5 条将 Special categories 画为「✦ 自动归类」，**仅为该标注样式的视觉示例**（已在 GitHub #6 评论决议）；实现以本节确定性映射为准，「自动归类」只用于真正未知的新章节。

## 6. 备注规则引擎（确定性，不走 LLM）

| 规则 | 触发条件 | 注入备注 | 优先级 |
|---|---|---|---|
| R1 | 所有材料项 | 「彩色扫描件，四角齐全，清晰可读」 | 基础 |
| R2 | 证件/证明类条目（默认对材料项生效） | 「非英文材料须附宣誓翻译（certified translation）或公证翻译件」 | 普通 |
| R3 | 条目命中 `police check` / `police certificate` / `penal clearance` / 无犯罪 | 「⚠️ 无犯罪记录证明如原件非英文，只能使用公证处出具的公证翻译件，不接受宣誓翻译」 | **覆盖 R2** |

- 规则表可配置（JSON），新增规则不改代码。
- 备注为中文固定文案，不经过翻译管道，保证逐字一致。

## 7. 标题与文档结构

```
澳大利亚学生签证（Subclass 500）申请材料清单
清单类型：Streamlined ｜ 护照国籍：中国 ｜ 院校：〈学校名/未定〉
数据来源：immi.homeaffairs.gov.au Document Checklist Tool ｜ 抓取时间：2026-07-19 14:32 AEST

一、个人身份类
  1. 护照个人信息页（Passport bio page）
     备注：彩色扫描件，四角齐全，清晰可读。
  ...
二、教育与工作背景类
  ...

免责声明：本清单由官网工具自动生成并翻译，仅供参考，不构成移民建议，以官网为准。
```

- 标题与元信息**本地拼接**（不经过 AI，见 §9 隐私约束）；标题不含姓名等任何个人信息。
- 抓取时间内部一律存 **UTC**，展示与导出时转为用户本地时区并带偏移量（如 `2026-07-19 14:32 +10:00`）；上例中的 `AEST` 仅为示意。
- 双语对照：中文为主，英文原文可展开/括注；官方术语保留英文括注（CoE、OSHC、GS、CRICOS…）。

## 8. 技术架构

- **壳**：Electron + React + TypeScript，复用 SSW.BookingPro `desktop/` 骨架（electron-builder、main/preload、credential-store、settings-store）。
- **Main process**：
  - `fetcher`：官网页面 + 两个 JSON 接口（浏览器 UA；Termstore 结果缓存 7 天，清单页每次生成实时抓取）；
  - `parser`：cheerio 解析清单 div → `{section, items[], links[]}`；
  - `classifier`：映射表 + AI 兜底；
  - `annotator`：规则引擎；
  - `translator`：AI Provider 层（见下），带顺序 fallback；
  - `exporter`：Markdown / PDF（Electron `webContents.printToPDF` 渲染专用打印模板，无额外依赖）/ 剪贴板。
- **Renderer**：三步向导——Step 1 输入表单（国家/院校本地模糊搜索）、Step 2 生成清单轻量视图（两阶段进度 + provider/fallback 提示，进度事件经 IPC 流式推送）、Step 3 中英双语清单视图与导出（MD/PDF/复制）；设置页（Provider 管理 + **日志**标签：逐条记录判定/抓取/解析/分类/备注/翻译/fallback 事件，仅存本机，可导出/清空）。

### AI Provider 层（多家可选，按序 fallback）

设置页可添加多家 API key，勾选启用并拖拽排序；翻译/兜底归类按顺序尝试，前一家失败自动切下一家：

| Provider | 接入方式 | 默认模型 | 计费备注 |
|---|---|---|---|
| Claude（Anthropic） | 官方 SDK `@anthropic-ai/sdk` | `claude-opus-4-8`（$5/$25 每 MTok），可切 `claude-sonnet-5`（$3/$15，2026-08-31 前 $2/$10） | 按量计费；单次生成量级 Opus ≈ $0.3、Sonnet ≈ $0.1 |
| ChatGPT（OpenAI） | 官方 SDK `openai` | 设置中可选（默认取当期旗舰） | 按量计费 |
| MiMo（小米） | OpenAI/Anthropic 双协议兼容 API → 复用 `openai` SDK + baseURL 覆写 | `mimo-v2.5-pro` / `mimo-v2.5`（1M 上下文 / 128K 输出） | ⚠️ **Token Plan 套餐制**：额度耗尽返回配额错误，必须视为可 fallback 错误自动切换下一家，并在 UI 提示「MiMo 套餐额度已用尽」 |

Fallback 触发条件（对所有 provider 统一）：认证失败（401/403）、限流（429）、**套餐/配额耗尽**、服务端错误（5xx）、结构化输出解析失败重试一次后仍失败。不可 fallback：网络完全不可用（直接报错）。每次生成在结果元信息中记录实际使用的 provider 与模型。

- 三家统一走**结构化 JSON 输出**（Claude 用 `output_config.format`；OpenAI/MiMo 用 `response_format: json_schema`），条目数组进 → 等长译文数组出，防漏译错位；
- 术语表进 system prompt（Claude 侧加 prompt caching）；三家共用同一份术语表与 prompt 模板，保证切换 provider 后术语一致；
- 所有 key 存 macOS Keychain，按 provider 命名空间隔离。

## 9. 非功能性需求与硬约束

1. **本机直连**：官网抓取只在用户 Mac 上进行，禁止云端代理（官网封数据中心 IP；也符合隐私原则）。
2. **隐私**：**App 不采集任何个人信息**——输入不含姓名/护照号等字段，文档标题不含姓名；发送给 AI provider 的内容仅为官网公开清单文本（Claude/OpenAI/MiMo 一视同仁）。
3. **时效性**：每次生成实时抓取；文档标注抓取时间。
4. **可降级**：结构指纹校验失败 → 内嵌 WebView 手动模式。
5. **合规**：固定免责声明；低频请求不做批量并发。
6. **凭据安全**：所有 provider 的 API key 均存 macOS Keychain，不落盘明文。

## 10. 风险登记

| 风险 | 等级 | 对策 |
|---|---|---|
| 逆向接口/页面结构随官网改版失效 | 高 | 结构指纹校验 + WebView 降级 + 文档标注抓取时间 |
| 移民建议合规风险 | 高 | 免责声明 + 双语原文对照可查 + 不做任何「建议」性输出 |
| 官网反爬升级 | 中 | 低频、单用户、浏览器 UA；失败降级 WebView |
| 学校匹配错误 | 中 | 本地模糊搜索由用户确认选择，AI 不参与选校 |
| 翻译术语漂移 | 低 | 术语表 + 结构化输出 + 双语对照 |

## 11. 迭代规划

| 迭代 | 内容 |
|---|---|
| **1**（本文档） | 500 签证完整链路：输入 → 抓取 → 分类 → 翻译 → 备注 → 标题 → 导出（Markdown + PDF + 剪贴板）；多 Provider 设置与顺序 fallback |
| 2 | 多申请人档案、清单勾选进度追踪 |
| 3 | 其他签证类别（visa listing 静态页解析）、官网清单变更 diff 提醒 |

## 12. 决议记录（原开放问题，2026-07-19 已确认）

1. **导出格式**：Markdown + **PDF** + 剪贴板，全部纳入 Iteration 1。✅
2. **API key 模式**：设置页自行添加，支持多家 provider（Claude / ChatGPT / MiMo）多选启用、按用户排序做 fallback。注意 MiMo 为 Token Plan 套餐计费，额度耗尽须自动 fallback。✅
3. **展示形态**：中英双语对照。✅
4. **三步向导修订**（2026-07-19，依据 mockups 定稿 Spec Review，Issue #2）：① Step 1 收敛为官网工具三个原生字段，**移除姓名字段**，App 全程不采集个人信息，文档标题不含姓名；② 原「生成进度视图」降为轻量 Step 2（搜索官网清单 → 翻译成中文两阶段 + provider/fallback 提示）；③ 细粒度过程改为写入 设置 → 日志。免责声明、抓取时间、清单类型三要素不受影响。✅
