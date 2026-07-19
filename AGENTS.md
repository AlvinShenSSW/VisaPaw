# AGENTS.md — VisaPaw 开发约定

本文件面向在此仓库工作的 AI 编码代理（Claude Code 等）与人类协作者。需求全文见 `docs/SPEC.md`，本文件只保留做开发决策时必须知道的事实与红线。

## 项目一句话

Mac 桌面 App（Electron + React + TypeScript）：输入护照国籍 + 意向院校（CRICOS）→ 从澳洲移民局官网 Document Checklist Tool 实时检索学生签（Subclass 500）材料清单 → 中文翻译（中英双语对照）+ 分类 + 合规备注 → 生成带标题的清单文档，导出 Markdown / PDF（Electron `printToPDF`）/ 剪贴板。

## 架构基线

- 复用 [SSW.BookingPro](https://github.com/AlvinShenSSW/SSW.BookingPro) 的 `desktop/` 骨架：electron-builder、`electron/main.ts` + `preload.ts`、React renderer、`credential-store.ts`（Keychain 存 API key）、`settings-store.ts`。
- **不需要 MCP server 层**，本 App 是单机直连应用。
- 抓取、解析、规则引擎、AI 调用全部在 **main process**；renderer 只做表单与展示，经 IPC 通信。Renderer 组成：三步向导（Step 1 输入 → Step 2 生成清单轻量视图 → Step 3 双语结果与导出）+ 设置页（Provider 管理 + 日志标签）。

## 关键技术事实（2026-07 已实测验证）

官网工具是 SharePoint WebForms 页面，**无需浏览器自动化、无需 reCAPTCHA token**，纯 HTTP 即可：

1. **下拉数据**：`POST https://immi.homeaffairs.gov.au/_layouts/15/api/Termstore.aspx/GetTermsByProperty`
   - body：`{"groupName":"IMMI","termSetName":"CountriesOfPassport","propertyName":"Code"}`（国家）或 `termSetName:"CRICOS"`（院校）
   - 返回：`{d:{success,data:[{ID,Key,Value}]}}`，Key=名称，Value=代码（国家为 ISO3，院校为 CRICOS 码）
2. **清单类型判定**：`POST https://immi.homeaffairs.gov.au/_layouts/15/api/ESB.aspx/GetStudentDocumentChecklistType`
   - body：`{"countryPassport":"CHN","provider":"NotListed","cricosCode":" ","studentEvidenceStudyTypeCode":"01"}`
   - 返回：`{d:{success,data:[{studentResult:"Regular"|"Streamlined"|"Undetermined"}]}}`
   - ✅ 选定院校入参已实测（2026-07-19）：`provider`=Termstore Key（校名）、`cricosCode`=Termstore Value（CRICOS 码）；未定院校用 `NotListed` + `" "`（见 SPEC §3）。
3. **清单内容**：抓取页面 `GET /visas/web-evidentiary-tool`（约 1.4MB），三套清单预渲染在 `div#Regular` / `div#Streamlined` / `div#Undetermined` 中，用 cheerio 解析。
4. 学生类型 `studentEvidenceStudyTypeCode`：`01` 普通 / `02` 中学交换 / `03` PhD 论文评审 / `04` DFAT / `05` 国防部。
5. 两个接口都需要 `Content-Type: application/json` 和浏览器 UA。

## 硬约束（红线，违反即 review 不通过）

1. **官网抓取只能从用户本机直连**。官网对数据中心 IP 返回 403；永远不要引入云端代理/服务器转发抓取。
2. **隐私**：**App 不采集申请人姓名、护照号等任何个人信息**（输入仅官网工具三字段，文档标题不含姓名）。发给任何 AI provider（Claude/OpenAI/MiMo 一视同仁）的只能是官网公开的清单文本。
3. **合规备注由确定性规则引擎注入，不交给 LLM 生成**。规则表在代码/配置中维护（见 SPEC §6）：
   - R1 所有材料：彩色扫描、四角齐全、清晰可读
   - R2 非英文材料：宣誓翻译（certified translation）或公证翻译
   - R3 police check / 无犯罪记录证明：非英文原件**只接受公证翻译**，不接受宣誓翻译（R3 覆盖 R2）
4. **分类先走确定性映射表**（官网章节 → 中文大类，见 SPEC §5），AI 只做未命中章节的兜底归类，且兜底结果必须在 UI/文档中标注。
5. 每份生成的文档必须带：数据抓取时间、清单类型（Regular/Streamlined/Undetermined）、免责声明（非移民建议，以官网为准）。

## AI Provider 层约定（多家可选，按序 fallback）

- 四家 provider，设置页添加 key、多选启用、按用户排序 fallback（默认顺序 MiMo → DeepSeek → ChatGPT → Claude，#34 决议；用户自定义排序升级时不被覆盖）：
  - **MiMo（小米）**：OpenAI 兼容 API（Token 计划端点），复用 `openai` SDK + baseURL 覆写；模型 `mimo-v2.5-pro` / `mimo-v2.5`。**注意 MiMo 是 Token Plan 套餐计费**——配额耗尽错误必须触发 fallback 并在 UI 提示。
  - **DeepSeek（深度求索）**：OpenAI 兼容端点（`api.deepseek.com/v1`），默认模型 `deepseek-v4-flash`；兼容端不支持 strict json_schema，结构化输出走 `response_format: json_object` + prompt 附带 schema + 编排层 zod 校验兜底。
  - **ChatGPT（OpenAI）**：官方 SDK `openai`；结构化输出走 `response_format: json_schema`。
  - **Claude**：官方 SDK `@anthropic-ai/sdk`，默认 `claude-opus-4-8`，可切 `claude-sonnet-5`；结构化输出走 `output_config.format`。
- Fallback 触发：401/403、429、套餐/配额耗尽、5xx、结构化输出解析重试一次仍失败。网络完全不可用不 fallback，直接报错。
- 每次生成的结果元信息记录实际使用的 provider 与模型。
- 翻译统一结构化 JSON 输出（zod schema）：条目数组进 → 等长译文数组出，防漏译错位。
- 术语表（CoE=入学确认书、OSHC=海外学生健康保险、GS=真实学生要求、CRICOS、Form 956/956A 等）各家共用同一份 prompt 模板，保证切换 provider 后术语一致；Claude 侧加 prompt caching。
- 所有 key 存 macOS Keychain（复用 BookingPro 的 credential-store 模式），按 provider 命名空间隔离，不落盘明文。

## 健壮性约定

- 启动/生成前做**结构指纹校验**：三个清单 div 与两个接口关键字段是否存在；失效时降级为内嵌 WebView 打开官网让用户手动操作，并提示 App 需要更新。
- 官网请求失败要有明确的用户可读错误（网络、403、结构变化三类分开）。
- 单用户低频请求，禁止批量并发抓取官网。

## 范围提醒

- Iteration 1 只做 **Subclass 500**。其他签证类别（485/482/600…）是官网另一套静态页面，属于后续迭代，不要顺手实现。
- 官网 Document Checklist Tool 仅覆盖学生签，这是产品事实，不是实现缺陷。
