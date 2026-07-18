import { describe, it, expect } from 'vitest';
import {
  aiMetaLabel,
  buildDisplayGroups,
  cnIndex,
  formatFetchedAt,
  termSegments,
} from '../renderer/views/step3-model.ts';
import type { GenerateResult } from '../common/types.ts';

const RESULT: GenerateResult = {
  checklistType: 'Streamlined',
  fetchedAt: '2026-07-19T04:32:00.000Z',
  params: {
    country: { key: 'China', value: 'CHN' },
    school: { key: 'The University of Melbourne (UniMelb)', value: '00116K' },
    studentTypeCode: '01',
  },
  groups: [
    {
      category: '个人身份类',
      sections: [
        {
          name: 'Identity',
          anchorId: 'div_Streamlined_Identity',
          autoClassified: false,
          pendingManual: false,
          items: [
            { en: 'Passport bio page.', zh: '护照个人信息页（Passport bio page）', links: [], notes: [] },
            { en: 'Birth certificate.', zh: '出生证明', links: [], notes: [] },
          ],
        },
      ],
    },
    {
      category: '教育与工作背景类',
      sections: [
        {
          name: 'Evidence of intended study',
          anchorId: null,
          autoClassified: false,
          pendingManual: false,
          items: [{ en: 'CoE for each course.', zh: '入学确认书（CoE）', links: [], notes: [] }],
        },
        {
          name: 'New section',
          anchorId: null,
          autoClassified: true,
          pendingManual: false,
          items: [{ en: 'Something new.', zh: '新章节条目', links: [], notes: [] }],
        },
      ],
    },
  ],
  aiMeta: { provider: 'claude', model: 'claude-opus-4-8' },
  aiMetas: [{ provider: 'claude', model: 'claude-opus-4-8' }],
  translationFailed: false,
};

describe('buildDisplayGroups（跨分类连续编号）', () => {
  it('编号 1..N 连续、组内条数与英文副标正确', () => {
    const groups = buildDisplayGroups(RESULT);
    expect(groups[0].items.map((r) => r.no)).toEqual([1, 2]);
    expect(groups[1].items.map((r) => r.no)).toEqual([3, 4]);
    expect(groups[0].itemCount).toBe(2);
    expect(groups[1].enSubtitle).toBe('Evidence of intended study · New section');
    expect(groups[1].items[1].autoClassified).toBe(true);
  });

  it('cnIndex 中文序号', () => {
    expect([cnIndex(0), cnIndex(1), cnIndex(6)]).toEqual(['一', '二', '七']);
  });
});

describe('termSegments（官方术语高亮）', () => {
  it('括注内术语被标记，其余文本保留', () => {
    const segs = termSegments('入学确认书（CoE, Confirmation of Enrolment）与 OSHC 保险');
    expect(segs.filter((s) => s.term).map((s) => s.text)).toEqual(['CoE', 'OSHC']);
    expect(segs.map((s) => s.text).join('')).toBe('入学确认书（CoE, Confirmation of Enrolment）与 OSHC 保险');
  });

  it('Form 956A 优先于 Form 956（最长匹配）', () => {
    const segs = termSegments('Form 956A 与 Form 956');
    expect(segs.filter((s) => s.term).map((s) => s.text)).toEqual(['Form 956A', 'Form 956']);
  });

  it('无术语时整段普通', () => {
    expect(termSegments('普通文本')).toEqual([{ text: '普通文本', term: false }]);
  });
});

describe('formatFetchedAt（UTC → 本地偏移展示，PR#17 决议）', () => {
  it('+10:00 与 +08:00 偏移正确换算', () => {
    expect(formatFetchedAt('2026-07-19T04:32:00.000Z', 600)).toBe('2026-07-19 14:32 +10:00');
    expect(formatFetchedAt('2026-07-19T04:32:00.000Z', 480)).toBe('2026-07-19 12:32 +08:00');
  });
  it('负偏移与非法输入', () => {
    expect(formatFetchedAt('2026-07-19T04:32:00.000Z', -330)).toBe('2026-07-18 23:02 -05:30');
    expect(formatFetchedAt('not-a-date')).toBe('not-a-date');
  });
});

describe('aiMetaLabel（红线 5：实际 provider）', () => {
  it('单 provider / 多 provider / 翻译失败三态', () => {
    expect(aiMetaLabel(RESULT)).toBe('翻译：Claude · claude-opus-4-8');
    expect(
      aiMetaLabel({
        ...RESULT,
        aiMetas: [
          { provider: 'mimo', model: 'mimo-v2.5-pro' },
          { provider: 'claude', model: 'claude-opus-4-8' },
        ],
      })
    ).toContain('多 provider 参与：MiMo → Claude');
    expect(aiMetaLabel({ ...RESULT, translationFailed: true, aiMeta: null })).toContain('暂不可用');
  });
});
