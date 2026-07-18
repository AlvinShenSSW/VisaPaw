/*
 * 清单 HTML 解析（main process）——cheerio 把 div#Regular / #Streamlined / #Undetermined
 * 解析为结构化章节与条目，保留官网原文与条目内链接（结果页「官网原文 ↗」用）。
 * 章节名归一化输出（去零宽/NBSP→空格/空白折叠）——#6 映射键以此为对齐基准。
 */

import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { ChecklistType } from './fetcher.ts';

const BASE = 'https://immi.homeaffairs.gov.au';

export interface ChecklistLink {
  text: string;
  href: string;
}

export interface ChecklistItem {
  /** 官网原文（归一化空白，内容不改写） */
  text: string;
  links: ChecklistLink[];
}

export interface ChecklistSection {
  name: string;
  /** 官网折叠块锚点（如 div_Regular_Identity），供原文跳转 */
  anchorId: string | null;
  items: ChecklistItem[];
}

/** 去零宽字符、NBSP→空格、空白折叠、trim */
export function normalizeText(raw: string): string {
  return raw
    .replace(/[​‌‍﻿]/g, '')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function absolutize(href: string): string {
  try {
    return new URL(href, BASE).href;
  } catch {
    return href;
  }
}

function extractLinks($: CheerioAPI, el: Cheerio<AnyNode>): ChecklistLink[] {
  const links: ChecklistLink[] = [];
  el.find('a[href]').each((_, a) => {
    const text = normalizeText($(a).text());
    const href = $(a).attr('href');
    if (text && href) links.push({ text, href: absolutize(href) });
  });
  return links;
}

/** 块级条目文本：li 需剔除嵌套子列表（子 li 单独成条） */
function blockText($: CheerioAPI, el: Cheerio<AnyNode>): string {
  const clone = el.clone();
  clone.find('ul, ol').remove();
  return normalizeText(clone.text());
}

export function parseChecklist(html: string, type: ChecklistType): ChecklistSection[] {
  const $ = cheerio.load(html);
  const root = $(`div#${type}`);
  if (root.length === 0) {
    throw new Error(`清单容器 div#${type} 不存在——官网可能已改版`);
  }
  const sections: ChecklistSection[] = [];
  root.find('.accordion-item').each((_, itemEl) => {
    const item = $(itemEl);
    const name = normalizeText(item.find('.header-text h3').first().text());
    if (!name) return; // 无标题的容器块不视为章节
    const collapse = item.find('.collapse').first();
    const anchorId = collapse.attr('id') ?? null;
    const items: ChecklistItem[] = [];
    collapse.find('p, li').each((__, blockEl) => {
      const block = $(blockEl);
      // li 内嵌 p 时只算外层 li 一条，防父子重复计数（快照为 0，防官网改版）
      if (blockEl.tagName === 'p' && block.parents('li').length > 0) return;
      const text = blockText($, block);
      if (!text) return;
      // 链接归属：不含子列表内的链接（子 li 自带）
      const clone = block.clone();
      clone.find('ul, ol').remove();
      items.push({ text, links: extractLinks($, clone) });
    });
    sections.push({ name, anchorId, items });
  });
  if (sections.length === 0) {
    throw new Error(`div#${type} 内未解析出任何章节——官网可能已改版`);
  }
  return sections;
}
