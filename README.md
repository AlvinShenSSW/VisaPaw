# VisaPaw 🐾

**澳大利亚签证材料清单助手（Mac App）** — Australian Visa Document Checklist Assistant for macOS.

VisaPaw 基于澳洲移民局官网的 [Document Checklist Tool](https://immi.homeaffairs.gov.au/visas/web-evidentiary-tool)，根据申请人的护照国籍、意向院校（CRICOS）与签证类别，自动检索最新官方材料清单，翻译成中文、按类别整理，并为每项材料注入合规备注（彩色扫描、宣誓/公证翻译要求等），一键生成可交付的《签证申请材料清单》。

## 状态

📋 规划阶段 — 见 [docs/SPEC.md](docs/SPEC.md)（需求文档 / Spec）。

第一迭代范围：**学生签证 Subclass 500** 完整链路。

## 技术栈

- Electron + React + TypeScript（架构复用 [SSW.BookingPro](https://github.com/AlvinShenSSW/SSW.BookingPro) 的 desktop 壳）
- 数据源：immi.homeaffairs.gov.au 官网接口（用户本机直连，无云端代理）
- 翻译/兜底归类：Anthropic Claude API（官方 TypeScript SDK）

## 给 AI 协作者

本仓库的开发约定与关键技术事实见 [AGENTS.md](AGENTS.md)。

## 免责声明

VisaPaw 生成的清单由官网工具自动检索并翻译，仅供参考，不构成移民建议。一切以 [immi.homeaffairs.gov.au](https://immi.homeaffairs.gov.au) 为准。
