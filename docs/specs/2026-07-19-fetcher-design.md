# #4 fetcher — 官网数据抓取层 + 结构指纹校验 — 设计文档

- 日期：2026-07-19 ｜ Issue：[#4](https://github.com/AlvinShenSSW/VisaPaw/issues/4)

## 模块形态

`electron/fetcher.ts`，main process 专用。所有网络与时钟依赖注入（`fetchImpl` / `now`），单测 100% fixture 回放、零真实请求。**无任何代理配置项**（红线：仅本机直连）。

## API

- `fetchTerms(kind: 'countries' | 'cricos')` → `TermItem[]{key,value}`——Termstore POST；**缓存 7 天**（cacheDir 注入，文件带 fetchedAt，过期或损坏即重抓）
- `fetchChecklistType({countryPassport, provider, cricosCode, studentTypeCode})` → `'Regular'|'Streamlined'|'Undetermined'`
- `fetchChecklistPage()` → `{html, fetchedAt}`——每次生成实时抓取，不缓存
- `verifyStructure(html, apiProbe)` → 结构指纹：`div#Regular/#Streamlined/#Undetermined` 三者齐全 + 两接口关键字段（`d.success`、`data[].Key/Value`、`studentResult`）

## 错误分类（供 #13 UI 三态呈现，类型驱动非字符串匹配）

`FetchError extends Error`，`kind: 'network' | 'forbidden' | 'structure'`：
- fetch 抛错 / 超时（AbortSignal 20s）→ `network`
- HTTP 403 → `forbidden`；其他非 2xx → `network`（带 status）
- 指纹校验失败 / 响应形状不符 → `structure`

## 请求约定

浏览器 UA + `Content-Type: application/json`（AGENTS 关键技术事实）；串行、无并发、无重试风暴（重试交给用户）。

## fixture 抓取（本次唯一真实请求会话，串行 + 间隔）

1. Termstore countries / CRICOS；2. 判定接口 CHN+NotListed（期望 Streamlined）；3. **判定接口选校变体实测**（provider=Termstore Key、cricosCode=Value 假设，SPEC §3 待实测项——结果回填 SPEC）；4. 清单页 1.4MB。
存放 `tests/fixtures/`：JSON 原样；清单页 gzip 入库（解压后供 #5 解析用）。

## 测试

fixture 回放：三端点解析、CHN+未定→Streamlined、403→forbidden、超时→network、指纹三 div 缺一→structure、缓存 7 天边界（注入时钟）、缓存损坏自愈。
