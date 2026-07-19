# VisaPaw Case 管理体系 — 架构与 UI/UX 设计方案（v1，待评审）

> 状态：**设计稿，未开发**。评审通过后拆分为 Iteration 2 的 Epic + 子 issue。
> Mockup：`mockups/06-case-list.html`（Case 列表 + 新建弹窗 + 空态/无结果态）、`mockups/07-case-detail.html`（侧边栏 Shell + case 内嵌三步向导）。

## 1. 背景与目标

Iteration 1 是「单 case」应用：打开即进三步向导，生成完即结束，结果不落盘。实际业务是**以申请人为中心的多 case 运营**：一个顾问同时服务多位申请人，每个 case 有自己的参数、生成历史，未来还有申请人资料、跟进记录、真实文件扫描件等生命周期内容。

本方案给出完整的 Case 管理体系设计：**数据库、IPC 契约、导航架构（左侧边栏）、Case 列表首页、新建流程、现有向导的嵌入方式**，并为未来扩展（资料/跟进/文件）预留结构。本期只评审方案与 mockup，不写代码。

## 2. 信息架构与导航

```
┌────────────┬──────────────────────────────────────────┐
│  左侧边栏   │  内容区                                    │
│  (216px)   │                                          │
│            │  /cases        → Case 列表（应用首页）      │
│  ▣ Case    │  /cases/:id    → Case 详情                │
│            │      └ 清单 tab = 现三步向导（Step1→2→3）   │
│  （未来）   │      └ 资料 / 跟进 / 文件 tab（占位，不开发） │
│  ▢ 文件库   │  /settings     → 设置（从右上角齿轮迁入）    │
│            │                                          │
│  ⚙ 设置    │                                          │
│  v0.2.0    │                                          │
└────────────┴──────────────────────────────────────────┘
```

- **侧边栏任何时候可导航**（UX 规则：当前项高亮 active 态；图标一律内联 SVG，不用 emoji）。
- **路由即状态**（deep-link 原则）：renderer 内部 route 结构 `{ view: 'cases' } | { view: 'case'; caseId; step } | { view: 'settings' }`，替代现在 App.tsx 的 wizard-only route。窗口标题随 route 同步。
- **生成进行中导航离开不打断**：pipeline 本就在 main 进程运行，离开 case 页只是 UI 切换；侧边栏与列表行显示进行中状态（spinner），回到该 case 恢复 Step 2 进度视图。仍维持「同时只有一个生成任务」的既有互斥。
- **设置入口**：从标题栏齿轮迁到侧边栏底部，标题栏只留窗口控制与当前页标题。

## 3. 数据层

### 3.1 存储选型：SQLite（better-sqlite3）

| 候选 | 结论 | 理由 |
|---|---|---|
| **SQLite（better-sqlite3）** | ✅ 采用 | 单文件零运维、同步 API 适合 main 进程、模糊搜索/筛选/分页天然支持、未来资料/跟进/文件表可平滑演进 |
| JSON 文件（沿用 settings 模式） | ❌ | 列表查询/模糊搜索/并发写入都要手写，case 数量增长后全量读写不可扩展 |
| sql.js（WASM） | ❌ | 全库驻内存 + 手动持久化，得不偿失 |

- 库文件：`userData/visapaw.db`，权限 0600（与日志同基线）。
- **原生模块打包**：better-sqlite3 需随 electron-builder 走 `@electron/rebuild`（现有打包链已内置该步骤，风险低；CI 上 `ELECTRON_SKIP_BINARY_DOWNLOAD` 不受影响，单测直接用 Node ABI 版本）。
- 迁移机制：`schema_migrations` 表 + 顺序号迁移脚本，启动时自动前滚；每个迁移是幂等 SQL 文件，随版本走。

### 3.2 Schema v1

```sql
CREATE TABLE cases (
  id            TEXT PRIMARY KEY,            -- ULID
  case_no       TEXT NOT NULL UNIQUE,        -- 'VP-2026-0001'，年内递增，展示/搜索用
  applicant_name TEXT NOT NULL,              -- 申请人姓名（PII，见 §5）
  country_key   TEXT NOT NULL,               -- Termstore Key，如 'China'
  country_value TEXT NOT NULL,               -- 如 'CHN'
  visa_type     TEXT NOT NULL DEFAULT 'Subclass 500',  -- 本期唯一取值，为未来签证类型留位
  school_key    TEXT,                        -- 选定院校（可空 = 未定）
  school_value  TEXT,
  student_type  TEXT,                        -- '01'–'05'，向导内选择后回写
  status        TEXT NOT NULL DEFAULT 'new', -- new | generated | archived
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_cases_search ON cases(case_no, applicant_name, country_key);

CREATE TABLE case_results (
  id         TEXT PRIMARY KEY,
  case_id    TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  result_json TEXT NOT NULL,                 -- GenerateResult 全量（复用现有类型）
  checklist_type TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_results_case ON case_results(case_id, created_at DESC);
```

- **生成结果落库**：向导生成成功后自动写 `case_results` 并置 case `status='generated'`；同 case 重复生成追加历史（v1 界面只展示最新一条，历史列表为未来功能，数据先留全）。
- **未来表（本期不建）**：`applicant_profiles`（护照号/生日等资料）、`followups`（跟进时间线）、`documents`（扫描件元数据；文件本体放 `userData/documents/<caseId>/`，库里只存路径+哈希）。设计原则：全部以 `case_id` 外键挂靠，case 删除级联清理。
- case 删除策略：v1 只提供**归档**（`status='archived'`，列表默认隐藏可筛出）；物理删除留待文件管理一起设计（涉及扫描件清理）。

### 3.3 IPC 契约（沿用现有 preload 白名单桥模式）

```ts
cases:list    (query: { text?: string; country?: string; visaType?: string;
                        status?: CaseStatus }) → CaseSummary[]   // 模糊搜索 + 筛选
cases:create  (input: { applicantName; country; visaType }) → CaseSummary
cases:get     (id) → CaseDetail                                  // 含最新结果
cases:update  (id, patch) → CaseSummary                          // 院校/学生类型回写等
cases:archive (id) → void
```

- 模糊搜索：`LIKE`（大小写不敏感）命中 `case_no / applicant_name / country_key`；拼音检索列（`name_pinyin`）为 schema 预留，不在 v1 实现。
- 现有 `generate:start` 增加 `caseId` 参数：生成归属明确，完成后 main 直接落库（renderer 不经手结果持久化）。

## 4. UI/UX 设计（见 mockup 06 / 07）

### 4.1 Case 列表页（应用首页，mockup 06）

- **顶部工具行**：模糊搜索框（case 号 / 姓名 / 国家，防抖 200ms）+ 两个下拉筛选（国家、状态；签证类型本期只有 500，下拉置灰显示）+ 右侧主按钮「＋ 新建 Case」。
- **表格列**：Case 号 · 姓名 · 国家 · 签证类型 · 状态 · 更新时间。行整行可点进详情（hover 高亮 + cursor-pointer）；状态用带色 pill（新建=灰、已生成=蓝、生成中=蓝+spinner、已归档=浅灰）。
- **空态**（首启）：插画位 + 「还没有 Case」+ 主按钮引导新建（UX 规则：空态必须给动作出口）。
- **无结果态**：「没有匹配『xxx』的 Case」+ 一键清除筛选（不留死胡同）。
- **表格溢出**：内容区最小宽度下表格横向滚动，不破坏布局。

### 4.2 新建 Case 弹窗（mockup 06 内）

- 字段：**申请人姓名**（必填）、**护照国籍**（Combobox 复用现组件，**默认中国**——与 issue #33 同一默认逻辑）、**签证类型**（本期固定 Subclass 500，禁用态展示）。
- 创建即入库（status=new）并跳转 case 详情 Step 1；国籍已预填，Step 1 不再重复询问国家（从 case 带入，可在 Step 1 修改并回写）。
- Esc / 取消可退出（modal escape route）。

### 4.3 Case 详情页（mockup 07）

- **头部**：case 号 + 姓名 + 国家 + 状态 pill；tab 行：**材料清单**（=现三步向导）、资料 / 跟进 / 文件（置灰「规划中」，不可点）。
- **清单 tab**：现有 Step 1→2→3 原样嵌入，视觉 token 不变；Step 1 的国家字段由 case 预填；生成完成 Step 3 结果自动存档到该 case。
- **标题栏**：不再有齿轮；显示「case 号 · 当前步骤」。
- 侧边栏在生成中导航离开：详情页驻留状态，列表行 + 侧边栏 case 项显示 spinner。

### 4.4 视觉基线

- **沿用现有 token 体系**（tokens.css 单源：天蓝 #2E9BDF / 深色 #4FB0F0、浅灰、白，浅/深双模式），侧边栏用 `--window` 底 + `--card` 内容区分层；**不引入新配色**。
- 图标：侧边栏/按钮一律内联 SVG（Lucide 风格线性图标），不用 emoji 当图标（🐾 仅作品牌符号保留在 logo 位）。
- 可达性：nav 项 aria-current、表格行键盘可达（↑↓ + Enter）、焦点环沿用现有 focus 样式、触达区 ≥ 36px 行高。

## 5. 隐私红线的扩展（必须随本体系一起生效）

姓名等申请人信息首次进入系统，红线相应扩展：

1. **AI 无个人信息**（现有红线不变）：翻译/分类请求体只含官网清单文本——case 字段（姓名等）**永不**进入任何 AI 请求。代码层面：pipeline 的输入契约不含姓名字段，类型上即不可能传入。
2. **日志无个人信息**（现有白名单机制扩展）：日志 params 白名单维持 `country/cricosCode/studentTypeCode`，新增 `caseNo`（编号可关联、不含姓名）；`applicantName` 不入日志。
3. **导出物**：文档标题维持「不含姓名」（SPEC §7 红线）；默认导出文件名维持现状（不带姓名）。是否在导出物内页加「Case 编号」水印 → 评审时定。
4. **本地存储**：DB 与扫描件目录同日志基线（0600、仅本机）；不做任何云同步。

## 6. 实施拆分建议（评审通过后建 Epic）

| 阶段 | 内容 | 依赖 |
|---|---|---|
| 2.1 | DB 层（better-sqlite3 + 迁移框架）+ cases CRUD IPC + 单测 | — |
| 2.2 | App Shell：侧边栏导航 + 路由重构 + 设置迁入 | 2.1 |
| 2.3 | Case 列表页（搜索/筛选/空态/无结果态）+ 新建弹窗 | 2.1, 2.2 |
| 2.4 | 向导嵌入 case 详情：参数预填/回写、结果落库、生成中状态 | 2.3 |
| 2.5 | issue #33（默认中国，融入新建弹窗与 Step 1）/ #34（DeepSeek） | 可并行 |
| 2.6 | E2E：多 case 全链路（新建→生成→落库→列表状态→重开） | 2.4 |

## 7. 开放问题（请评审时决策）

1. **Case 号格式**：`VP-2026-0001`（年份+4 位递增）是否符合业务习惯？是否需要可配置前缀？
2. **归档 vs 删除**：v1 仅归档是否可接受？
3. **重复生成**：同 case 再次生成默认「追加历史、展示最新」，是否需要一开始就露出历史版本入口？
4. **导出物是否带 Case 编号**（页眉或元信息行）？
