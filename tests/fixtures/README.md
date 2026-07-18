# 官网 fixture 快照

抓取于 **2026-07-19 03:35（本机住宅 IP，浏览器 UA，串行 + 3s 间隔）**——AFK 约束下的唯一一次真实请求会话。此后所有测试与 E2E 一律 fixture 回放,不得真实请求官网。

| 文件 | 来源 | 说明 |
|---|---|---|
| `termstore-countries.json` | `POST /_layouts/15/api/Termstore.aspx/GetTermsByProperty`（CountriesOfPassport） | 237 国 |
| `termstore-cricos.json` | 同上（CRICOS） | 1669 院校 |
| `checklist-type-chn-notlisted.json` | `POST /_layouts/15/api/ESB.aspx/GetStudentDocumentChecklistType` | CHN + NotListed → Streamlined |
| `checklist-type-chn-selected.json` | 同上 | CHN + UniMelb(00116K) → Streamlined；`_probe` 字段记录实测入参 |
| `evidentiary-tool.html.gz` | `GET /visas/web-evidentiary-tool` | 1,409,238 bytes 原页 gzip；三清单 div（Regular/Streamlined/Undetermined）齐全 |

官网改版导致 fixture 过期时：重新执行一次抓取会话并整体替换本目录,同时核对结构指纹与 SPEC §3。
