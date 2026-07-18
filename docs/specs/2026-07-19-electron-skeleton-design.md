# #3 Electron 骨架与 macOS 视觉基线 — 设计文档

- 日期：2026-07-19 ｜ Issue：[#3](https://github.com/AlvinShenSSW/VisaPaw/issues/3) ｜ 状态：已定稿
- 基线：SSW.BookingPro `desktop/`（v2.1.7，sparse checkout 实测比对）

## 复用与偏离

| BookingPro 模式 | VisaPaw 采用 | 理由 |
|---|---|---|
| esbuild 打包 main/preload → CJS，vite 打包 renderer | ✅ 原样复用（去掉 jsToTs 插件——无 NodeNext 后端桥接需求） | 已验证的双进程构建链 |
| 内嵌 express API server + `api:base` IPC | ❌ 移除 | AGENTS：单机应用，模块在 main process 内直接经 IPC 暴露，无 HTTP 层 |
| `credential-store.ts`：safeStorage 加密单一凭据 blob | ✅ 改为**按 provider 命名空间**的多 key 存储（`claude`/`openai`/`mimo`），文件 0600 + 原子写 | AGENTS Provider 层约定 |
| `settings-store.ts`：sanitize + patch 合并 | ✅ 复用模式，schema 换为 VisaPaw（provider 顺序/启用/模型 + 学生类型默认值） | 同一防御式写法 |
| `contextIsolation + sandbox + preload 白名单桥` | ✅ 原样复用 | 安全基线 |
| 自定义暗色 `backgroundColor:'#111'`，默认标题栏 | ✅ 改 `titleBarStyle:'hiddenInset'` + 跟随系统深浅色 | #3 评论决议（PR #17 Kimi minor）：保留原生红绿灯 |

## IPC 面（#3 仅骨架，后续 issue 扩展）

`window.visapaw`（preload 白名单桥）：
- `getSettings() / setSettings(patch)` — 设置读写（sanitize 后深合并）
- `setProviderKey(provider, key) / getProviderKeyStatus()` — key 单向写入 Keychain；**renderer 只拿到 `{saved, prefix}` 状态，永不返回 key 明文/掩码派生值**（#12 决议）
- `getSystemStatus()` — 深浅色当前值等骨架状态

## 设计 token（单一文件 `renderer/styles/tokens.css`）

- 取值逐字来自 `mockups/01–05` 的 `:root` 变量集（浅色 + `prefers-color-scheme: dark` 深色两套，含 accent/desktop/window/card/text×3/border×2/ok/warn×3/danger×2/shadow/field-bg）
- 字体栈 `-apple-system, PingFang SC`；正文 13–14.5px；数字 `font-variant-numeric: tabular-nums`
- 其余样式文件只引用 var，不得出现硬编码色值（CI lint 用 stylelint 太重——用单测扫描 `renderer/**/*.css` 中 tokens.css 之外的十六进制色值，0 命中）

## 渲染层骨架

#3 只交付壳：三步向导容器（步骤指示器占位）+ 设置入口 + 状态栏,证明 token/深浅色/窗口 chrome;真实页面在 #9–#13 按 mockup 落地。

## 测试与 CI

- vitest：`settings-store.sanitize`、`credential-store` 命名空间读写（safeStorage mock）、token 硬编码色值扫描
- typecheck ×2（renderer bundler / electron NodeNext）+ eslint（ts 推荐集）
- CI（GitHub Actions，ubuntu）：`npm ci → lint → typecheck → test → build`；Electron 启动冒烟（`VISAPAW_SMOKE=1` ready 后自动退出）仅本机跑——ubuntu runner 无显示服务,记录为已知取舍
- 验收「npm run dev 深浅色自动切换」：本机冒烟 + tokens 的 `prefers-color-scheme` 媒体查询单测双保险
