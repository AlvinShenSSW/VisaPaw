import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { generateChecklist } from '../electron/pipeline.ts';
import { buildMarkdown, buildPlainText, buildPrintHtml } from '../electron/exporter.ts';
import { buildDisplayGroups, formatFetchedAt } from '../common/result-view.ts';
import type { AiService } from '../electron/ai/orchestrator.ts';
import type { Fetcher } from '../electron/fetcher.ts';
import type { GenerateResult } from '../common/types.ts';
import { vi } from 'vitest';

const pageHtml = gunzipSync(
  readFileSync(join(process.cwd(), 'tests', 'fixtures', 'evidentiary-tool.html.gz'))
).toString('utf8');

function stubFetcher(): Fetcher {
  return {
    fetchTerms: vi.fn(),
    fetchChecklistType: vi.fn().mockResolvedValue('Streamlined'),
    fetchChecklistPage: vi
      .fn()
      .mockResolvedValue({ html: pageHtml, fetchedAt: '2026-07-19T04:32:00.000Z' }),
    verifyStructure: () => true,
  } as unknown as Fetcher;
}

const stubAi = (): AiService => ({
  async translate(items: string[]) {
    return {
      translations: items.map((t) => `【中文】${t.slice(0, 12)}`),
      meta: { provider: 'claude' as const, model: 'claude-opus-4-8' },
    };
  },
  async classifySection() {
    return { category: '品行类', meta: { provider: 'claude' as const, model: 'claude-opus-4-8' } };
  },
});

let cached: GenerateResult | null = null;
async function result(): Promise<GenerateResult> {
  cached ??= await generateChecklist(
    { country: { key: 'China', value: 'CHN' }, school: 'undecided', studentTypeCode: '01' },
    { fetcher: stubFetcher(), createAiService: () => stubAi() }
  );
  return cached;
}

describe('三种导出的红线要素（任何导出物不可省略）', () => {
  it('Markdown / 纯文本 / 打印 HTML 均含 三要素 + 实际 provider', async () => {
    const r = await result();
    for (const text of [buildMarkdown(r), buildPlainText(r), buildPrintHtml(r)]) {
      expect(text).toContain('Streamlined'); // 清单类型
      expect(text).toContain(formatFetchedAt(r.fetchedAt)); // 抓取时间
      expect(text).toContain('免责声明'); // 免责声明
      expect(text).toContain('不构成移民建议');
      expect(text).toContain('claude-opus-4-8'); // 实际 provider
      expect(text).toContain('澳大利亚学生签证（Subclass 500）申请材料清单');
      // 通用要求头部一处、且仅一处（产品决议 2026-07-19：不逐条重复）
      expect(text).toContain('通用要求（适用于以下全部材料）');
      expect(text.match(/彩色扫描件，四角齐全，清晰可读/g)).toHaveLength(1);
    }
  });
});

describe('与结果视图逐条一致（共用 buildDisplayGroups 构造保证 + 快照断言）', () => {
  it('Markdown 条目数与编号与结果视图完全一致', async () => {
    const r = await result();
    const groups = buildDisplayGroups(r);
    const rows = groups.flatMap((g) => g.items);
    const md = buildMarkdown(r);
    for (const row of rows) {
      const main = (row.item.zh ?? row.item.en).slice(0, 12);
      expect(md).toContain(`${row.no}. `);
      expect(md).toContain(main);
    }
    // 分类标题与条数
    for (const g of groups) {
      expect(md).toContain(g.category);
    }
    // 最后编号 = 总条数（连续编号）
    expect(md).toContain(`${rows.length}. `);
  });

  it('R3 警告与普通备注在打印模板中分层（warn class）', async () => {
    // Streamlined 快照无 police 条目——构造含 R3 warning 备注的结果验证分层
    const r = await result();
    const withWarn: GenerateResult = {
      ...r,
      groups: [
        {
          category: '品行类',
          sections: [
            {
              name: 'Character',
              anchorId: null,
              autoClassified: false,
              pendingManual: false,
              items: [
                {
                  en: 'A police certificate from each country.',
                  zh: '无犯罪记录证明',
                  links: [],
                  notes: [
                    { ruleId: 'R1', note: '彩色扫描件，四角齐全，清晰可读', level: 'normal' },
                    {
                      ruleId: 'R3',
                      note: '⚠️ 无犯罪记录证明如原件非英文，只能使用公证处出具的公证翻译件，不接受宣誓翻译',
                      level: 'warning',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const html = buildPrintHtml(withWarn);
    expect(html).toContain('class="note warn"');
    expect(html).toContain('只能使用公证处出具的公证翻译件');
    expect(html).toContain('class="note"');
    expect(html).toContain('彩色扫描件，四角齐全，清晰可读。');
    const md = buildMarkdown(withWarn);
    expect(md).toContain('⚠️ 备注：');
  });

  it('打印模板含分页保护（单条不截断）与中文字体栈', async () => {
    const html = buildPrintHtml(await result());
    expect(html).toContain('break-inside: avoid');
    expect(html).toContain('page-break-inside: avoid');
    expect(html).toContain('PingFang SC');
  });

  it('HTML 转义：条目文本中的特殊字符不破坏模板', async () => {
    const r = await result();
    const hacked: GenerateResult = {
      ...r,
      groups: [
        {
          category: '个人身份类',
          sections: [
            {
              name: 'X<script>alert(1)</script>',
              anchorId: null,
              autoClassified: false,
              pendingManual: false,
              items: [{ en: 'a & b <i>', zh: '中 & 文 <b>', links: [], notes: [] }],
            },
          ],
        },
      ],
    };
    const html = buildPrintHtml(hacked);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('中 &amp; 文 &lt;b&gt;');
  });

  it('HTML 属性转义：URL/文本中的引号不可逃出属性（Kimi PR#30 P2）', async () => {
    const r = await result();
    const hacked: GenerateResult = {
      ...r,
      groups: [
        {
          category: '个人身份类',
          sections: [
            {
              name: 'S',
              anchorId: null,
              autoClassified: false,
              pendingManual: false,
              items: [
                {
                  en: 'x',
                  zh: '中',
                  links: [{ text: 't', href: 'https://x.example/a" onclick="alert(1)' }],
                  notes: [],
                },
              ],
            },
          ],
        },
      ],
    };
    const html = buildPrintHtml(hacked);
    expect(html).not.toContain('" onclick="');
    expect(html).toContain('&quot; onclick=&quot;');
  });

  it('Markdown 元字符转义：原文 */`/#/[] 不破坏结构；纯文本保持原样（Kimi PR#30 P2）', async () => {
    const r = await result();
    const hacked: GenerateResult = {
      ...r,
      groups: [
        {
          category: '个人身份类',
          sections: [
            {
              name: 'Iden*tity',
              anchorId: null,
              autoClassified: false,
              pendingManual: false,
              items: [
                {
                  en: 'Provide *original* `documents` #now [ref]',
                  zh: '含*星号*的译文',
                  links: [{ text: 'my *doc*', href: 'https://x.example/a(b)' }],
                  notes: [],
                },
              ],
            },
          ],
        },
      ],
    };
    const md = buildMarkdown(hacked);
    expect(md).toContain('含\\*星号\\*的译文');
    expect(md).toContain('Iden\\*tity — Provide \\*original\\* \\`documents\\` \\#now \\[ref\\]');
    expect(md).toContain('[my \\*doc\\*](<https://x.example/a(b)>)');
    // 纯文本从结构化数据直接生成——不残留任何转义符/格式符
    const plain = buildPlainText(hacked);
    expect(plain).toContain('含*星号*的译文');
    expect(plain).toContain('英文原文：Iden*tity — Provide *original* `documents` #now [ref]');
    expect(plain).toContain('- 链接：my *doc*（https://x.example/a(b)）');
    expect(plain).not.toContain('\\*');
    // 打印模板同样枚举条目链接，URL 纸面可见（Kimi PR#30 minor）
    const html = buildPrintHtml(hacked);
    expect(html).toContain('链接：<a href="https://x.example/a(b)">my *doc*</a>（https://x.example/a(b)）');
  });

  it('链接协议白名单：非 http(s) 链接在三种导出中降级为纯文本（Kimi PR#30 P2）', async () => {
    const r = await result();
    const hacked: GenerateResult = {
      ...r,
      groups: [
        {
          category: '个人身份类',
          sections: [
            {
              name: 'S',
              anchorId: 'anchor-x',
              autoClassified: false,
              pendingManual: false,
              items: [
                {
                  en: 'x',
                  zh: '中',
                  links: [{ text: 'evil', href: 'javascript:alert(1)' }],
                  notes: [],
                },
              ],
            },
          ],
        },
      ],
    };
    for (const text of [buildMarkdown(hacked), buildPlainText(hacked), buildPrintHtml(hacked)]) {
      expect(text).not.toContain('javascript:');
      expect(text).toContain('evil');
    }
    // 原文链接回退跳过非法首链，落到清单页锚点
    expect(buildMarkdown(hacked)).toContain('web-evidentiary-tool#anchor-x');
  });
});

describe('降级态导出（翻译失败仍完整）', () => {
  it('translationFailed：英文主行 + 三要素 + 「暂不可用」标注', async () => {
    const r = await result();
    const failed: GenerateResult = {
      ...r,
      translationFailed: true,
      aiMeta: null,
      aiMetas: [],
      groups: r.groups.map((g) => ({
        ...g,
        sections: g.sections.map((s) => ({
          ...s,
          items: s.items.map((i) => ({ ...i, zh: undefined })),
        })),
      })),
    };
    const md = buildMarkdown(failed);
    expect(md).toContain('暂不可用');
    expect(md).toContain('免责声明');
    expect(md).not.toContain('【中文】');
    // 无译文时主行即英文，但官网原文链接仍保留（Codex PR#30 P2）
    expect(md).toContain('[官网原文 ↗](');
  });

  it('两位数编号的续行缩进与编号宽度一致（Codex PR#30 P2）；链接保留', async () => {
    const r = await result();
    const md = buildMarkdown(r);
    // 第 10 条之后的引用行必须是 4 空格缩进（"10. " 宽度）
    if (md.includes('10. ')) {
      const after10 = md.slice(md.indexOf('\n10. '));
      const firstQuote = after10.split('\n').find((l) => l.trimStart().startsWith('>'));
      if (firstQuote) expect(firstQuote.startsWith('    >')).toBe(true);
    }
    expect(md).toContain('[官网原文 ↗](<https://immi.homeaffairs.gov.au/visas/web-evidentiary-tool');
    // 纯文本中链接降级为「文本（URL）」
    const plain = buildPlainText(r);
    expect(plain).toContain('官网原文 ↗（https://');
    expect(plain).not.toContain('](');
  });
});
