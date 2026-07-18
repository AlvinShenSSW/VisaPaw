import { describe, it, expect } from 'vitest';
import { DEFAULT_RULES, annotateItem, parseRules } from '../electron/annotator.ts';

describe('R1–R3 规则语义（表驱动，F4 决议）', () => {
  it('R2 正例：普通材料项 → R1 + R2（顺序按规则表）', () => {
    const notes = annotateItem('Evidence of your identity. Attach a copy of your passport.');
    expect(notes.map((n) => n.ruleId)).toEqual(['R1', 'R2']);
    expect(notes.every((n) => n.level === 'normal')).toBe(true);
  });

  const r3Variants = [
    'Provide a police check for each country you lived in.',
    'Attach your Police Certificate issued within 12 months.',
    'A penal clearance certificate is required.',
    '提供无犯罪记录证明。',
  ];
  for (const text of r3Variants) {
    it(`R3 覆盖例：「${text.slice(0, 24)}…」→ 仅 R1 + R3（R3 覆盖 R2、不覆盖 R1）`, () => {
      const notes = annotateItem(text);
      expect(notes.map((n) => n.ruleId)).toEqual(['R1', 'R3']);
      expect(notes.find((n) => n.ruleId === 'R3')?.level).toBe('warning');
    });
  }

  it('文案与 SPEC §6 逐字一致（不经翻译管道）', () => {
    const notes = annotateItem('any item');
    expect(notes.find((n) => n.ruleId === 'R1')?.note).toBe('彩色扫描件，四角齐全，清晰可读');
    expect(notes.find((n) => n.ruleId === 'R2')?.note).toBe(
      '非英文材料须附宣誓翻译（certified translation）或公证翻译件'
    );
    const r3 = annotateItem('police check').find((n) => n.ruleId === 'R3');
    expect(r3?.note).toBe(
      '⚠️ 无犯罪记录证明如原件非英文，只能使用公证处出具的公证翻译件，不接受宣誓翻译'
    );
  });

  it('关键词匹配大小写不敏感', () => {
    expect(annotateItem('POLICE CHECK required').map((n) => n.ruleId)).toEqual(['R1', 'R3']);
  });
});

describe('JSON 可配置（新增规则不改代码）', () => {
  it('parseRules 接受合法配置并在引擎中生效', () => {
    const rules = parseRules([
      ...DEFAULT_RULES,
      {
        id: 'R4',
        trigger: { type: 'keyword', keywords: ['OSHC'] },
        note: '保险起保日期须覆盖整个签证周期',
        level: 'normal',
      },
    ]);
    const notes = annotateItem('Evidence of OSHC health insurance.', rules);
    expect(notes.map((n) => n.ruleId)).toEqual(['R1', 'R2', 'R4']);
  });

  it('非法配置（缺 note / 空 keywords / 未知 level）被拒绝', () => {
    expect(() => parseRules([{ id: 'X', trigger: { type: 'all' }, level: 'normal' }])).toThrow(/不合法/);
    expect(() =>
      parseRules([{ id: 'X', trigger: { type: 'keyword', keywords: [] }, note: 'n', level: 'normal' }])
    ).toThrow(/不合法/);
    expect(() =>
      parseRules([{ id: 'X', trigger: { type: 'all' }, note: 'n', level: 'red' }])
    ).toThrow(/不合法/);
    // 空串/纯空白关键词会命中一切条目（Codex 外门 P2）
    expect(() =>
      parseRules([{ id: 'X', trigger: { type: 'keyword', keywords: [''] }, note: 'n', level: 'normal' }])
    ).toThrow(/不合法/);
    expect(() =>
      parseRules([{ id: 'X', trigger: { type: 'keyword', keywords: ['  '] }, note: 'n', level: 'normal' }])
    ).toThrow(/不合法/);
  });

  it('覆盖仅在覆盖者触发时生效：无 R3 关键词的条目 R2 保留', () => {
    const notes = annotateItem('Provide your birth certificate.');
    expect(notes.map((n) => n.ruleId)).toContain('R2');
  });

  it('自定义覆盖链：新规则可覆盖 R1（数据驱动，不改引擎）', () => {
    const rules = parseRules([
      ...DEFAULT_RULES,
      {
        id: 'R9',
        trigger: { type: 'keyword', keywords: ['digital only'] },
        note: '仅接受电子件',
        level: 'normal',
        overrides: ['R1'],
      },
    ]);
    const notes = annotateItem('Submit digital only copies.', rules);
    expect(notes.map((n) => n.ruleId)).toEqual(['R2', 'R9']);
  });
});
