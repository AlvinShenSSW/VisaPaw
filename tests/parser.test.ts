import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseChecklist } from '../electron/parser.ts';

const pageHtml = gunzipSync(
  readFileSync(join(process.cwd(), 'tests', 'fixtures', 'evidentiary-tool.html.gz'))
).toString('utf8');

const REGULAR_SECTIONS = [
  'Identity',
  'Evidence of intended study',
  'Welfare arrangements for under 18 year old student',
  'Parental consent',
  'Health insurance',
  'Evidence of financial capacity',
  'Evidence of English language ability',
  'Genuine Student requirement',
  'Change of name',
  'Relationship - spouse, de facto partner',
  'Employment history',
  'Migration agent - Form 956 Advice by a migration agent/exempt person',
  'Appointment or withdrawal of an authorised recipient - Form 956A',
  'Evidence of school enrolment for dependants',
  'Research Students',
];

describe('parseChecklist（官网真实快照）', () => {
  it('Regular 解析出 15 个章节，名称与快照逐字一致（归一化后）', () => {
    const sections = parseChecklist(pageHtml, 'Regular');
    expect(sections.map((s) => s.name)).toEqual(REGULAR_SECTIONS);
  });

  it('Streamlined 13 章节 / Undetermined 15 章节（含 Special categories）', () => {
    expect(parseChecklist(pageHtml, 'Streamlined')).toHaveLength(13);
    const und = parseChecklist(pageHtml, 'Undetermined');
    expect(und).toHaveLength(15);
    expect(und.map((s) => s.name)).toContain('Special categories');
    expect(und[0].name).toBe('Evidence of your identity');
  });

  it('章节名不残留零宽字符 / NBSP / 多余空白', () => {
    for (const type of ['Regular', 'Streamlined', 'Undetermined'] as const) {
      for (const s of parseChecklist(pageHtml, type)) {
        expect(s.name).not.toMatch(/[​‌‍﻿ ]/);
        expect(s.name).toBe(s.name.trim().replace(/\s+/g, ' '));
      }
    }
  });

  it('条目保留官网原文；Identity 章节含护照要求原文', () => {
    const identity = parseChecklist(pageHtml, 'Regular')[0];
    expect(identity.anchorId).toBe('div_Regular_Identity');
    expect(identity.items.length).toBeGreaterThan(0);
    expect(identity.items.map((i) => i.text).join(' ')).toMatch(/passport/i);
  });

  it('条目内链接抽取并绝对化到官网域', () => {
    const all = parseChecklist(pageHtml, 'Regular').flatMap((s) => s.items.flatMap((i) => i.links));
    expect(all.length).toBeGreaterThan(0);
    for (const l of all) {
      expect(l.href).toMatch(/^https?:\/\//);
      expect(l.text.length).toBeGreaterThan(0);
    }
  });

  it('每个章节 anchorId 形如 div_<Type>_*（供官网原文跳转）', () => {
    for (const s of parseChecklist(pageHtml, 'Regular')) {
      expect(s.anchorId).toMatch(/^div_Regular_/);
    }
  });
});

describe('parseChecklist（合成 HTML 边界）', () => {
  const wrap = (inner: string) => `<html><body><div id="Regular">${inner}</div></body></html>`;
  const item = (h3: string, collapse: string, anchor = 'div_Regular_X') =>
    `<div class="accordion-item"><div class="row accordion-header"><div class="header-text"><h3>${h3}</h3></div></div><div class="collapse" id="${anchor}">${collapse}</div></div>`;

  it('空章节 → items: []', () => {
    const sections = parseChecklist(wrap(item('Empty section', '')), 'Regular');
    expect(sections).toEqual([
      { name: 'Empty section', anchorId: 'div_Regular_X', items: [] },
    ]);
  });

  it('嵌套列表：父 li 文本剔除子列表，子 li 单独成条', () => {
    const html = wrap(
      item('Nested', '<ul><li>Parent point<ul><li>Child A</li><li>Child B</li></ul></li><li>Sibling</li></ul>')
    );
    const texts = parseChecklist(html, 'Regular')[0].items.map((i) => i.text);
    expect(texts).toEqual(['Parent point', 'Child A', 'Child B', 'Sibling']);
  });

  it('a 标签内联：文本保留、链接归属条目并绝对化', () => {
    const html = wrap(item('Links', '<p>See <a href="/visas/foo">the form</a> here.</p>'));
    const [{ items }] = parseChecklist(html, 'Regular');
    expect(items[0].text).toBe('See the form here.');
    expect(items[0].links).toEqual([
      { text: 'the form', href: 'https://immi.homeaffairs.gov.au/visas/foo' },
    ]);
  });

  it('纯空白条目被剔除', () => {
    const html = wrap(item('Blank items', '<p>   </p><p>Real</p><li>​</li>'));
    expect(parseChecklist(html, 'Regular')[0].items.map((i) => i.text)).toEqual(['Real']);
  });

  it('目标 div 缺失 → 抛错（结构异常）', () => {
    expect(() => parseChecklist('<html><body></body></html>', 'Regular')).toThrow(/Regular/);
  });

  it('div 存在但零章节 → 抛错', () => {
    expect(() => parseChecklist(wrap(''), 'Regular')).toThrow(/章节/);
  });
});
