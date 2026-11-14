/**
 * 模块一 · 决策读写 recipe 与回看视图（PRD §3.1 OFF-7 / OFF-8 / OFF-10）。
 *
 * 这里最要紧的两条是「不越权」：
 * - `applyDecision` 只写 `draft.offerDecision`，一个 Application 字段都不许碰；
 * - `applyOfferPatch` 不写 note、不动 `lastActivityAt`（改了薪资不该让沉默天数归零）。
 * 所以断言里专门盯着「哪些东西**没有**变」。
 */

import { describe, expect, it } from 'vitest';
import type { Application, DB, OfferDecision } from '../../types';
import { emptyDB } from '../defaults';
import {
  DECISION_NOTE_LIMIT,
  DELETED_DECISION_LABEL,
  REASON_TAG_PRESETS,
  applyDecision,
  applyOfferPatch,
  decisionToMarkdown,
  decisionViewOf,
  sanitizeReasonTags,
} from './decision';
import type { CompareRow } from './compare';

const NOW_ISO = '2026-11-01T09:00:00.000Z';

function makeDB(): DB {
  const db = emptyDB();
  db.companies = [
    { id: 'c1', name: '字节跳动', shortName: '字节', createdAt: '2026-09-01T00:00:00.000Z' },
    { id: 'c2', name: '美团', createdAt: '2026-09-01T00:00:00.000Z' },
  ];
  const base: Application = {
    id: 'a1',
    companyId: 'c1',
    jobTitle: '前端开发',
    status: 'offer',
    statusChangedAt: NOW_ISO,
    lastActivityAt: NOW_ISO,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
  db.applications = [
    base,
    { ...base, id: 'a2', companyId: 'c2', jobTitle: '后端开发' },
  ];
  return db;
}

describe('sanitizeReasonTags', () => {
  it('内置 8 个理由标签（顺序固定，UI 直接渲染）', () => {
    expect(REASON_TAG_PRESETS).toHaveLength(8);
    expect(REASON_TAG_PRESETS.map((item) => item.label)).toEqual([
      '薪资',
      '成长',
      '城市',
      'WLB',
      '团队',
      '品牌',
      '转正',
      '截止',
    ]);
  });

  it('去空、去重、每个 ≤10 字截断、最多 5 个', () => {
    expect(
      sanitizeReasonTags([' 薪资 ', '', '薪资', '一二三四五六七八九十十一', '成长', '城市', 'WLB', '团队']),
    ).toEqual(['薪资', '一二三四五六七八九十', '成长', '城市', 'WLB']);
  });

  it('非数组 / 全是非字符串 → 空数组', () => {
    expect(sanitizeReasonTags(undefined)).toEqual([]);
    expect(sanitizeReasonTags('薪资')).toEqual([]);
    expect(sanitizeReasonTags([1, null, {}])).toEqual([]);
  });
});

describe('applyDecision · 只改 offerDecision', () => {
  it('★ 写决策不动任何投递字段（记录选择 ≠ 已经拒了别人）', () => {
    const db = makeDB();
    const before = JSON.parse(JSON.stringify(db.applications)) as Application[];
    applyDecision(db, {
      applicationId: 'a1',
      decidedAt: '2026-11-01',
      reasonTags: ['薪资', '城市'],
      note: '离家近，钱也多',
      declinedIds: ['a2'],
    });
    expect(db.applications).toEqual(before);
    expect(db.offerDecision).toEqual({
      applicationId: 'a1',
      decidedAt: '2026-11-01',
      reasonTags: ['薪资', '城市'],
      note: '离家近，钱也多',
      declinedIds: ['a2'],
    });
  });

  it('改选即覆盖（一个人一次只能选一个 Offer）', () => {
    const db = makeDB();
    applyDecision(db, { applicationId: 'a1', decidedAt: '2026-11-01', reasonTags: ['薪资'] });
    applyDecision(db, { applicationId: 'a2', decidedAt: '2026-11-05', reasonTags: [] });
    expect(db.offerDecision?.applicationId).toBe('a2');
    expect(db.offerDecision?.reasonTags).toEqual([]);
  });

  it('note 清空 / declinedIds 空 → 键不出现（不写空串占位）', () => {
    const db = makeDB();
    applyDecision(db, {
      applicationId: 'a1',
      decidedAt: '2026-11-01',
      reasonTags: [],
      note: '   ',
      declinedIds: [],
    });
    expect(db.offerDecision).toEqual({ applicationId: 'a1', decidedAt: '2026-11-01', reasonTags: [] });
  });

  it('note 截断到 500 字', () => {
    const db = makeDB();
    applyDecision(db, {
      applicationId: 'a1',
      decidedAt: '2026-11-01',
      reasonTags: [],
      note: '字'.repeat(600),
    });
    expect(db.offerDecision?.note).toHaveLength(DECISION_NOTE_LIMIT);
  });

  it('declinedIds 去重并剔除自己', () => {
    const db = makeDB();
    applyDecision(db, {
      applicationId: 'a1',
      decidedAt: '2026-11-01',
      reasonTags: [],
      declinedIds: ['a2', 'a2', 'a1'],
    });
    expect(db.offerDecision?.declinedIds).toEqual(['a2']);
  });
});

describe('applyOfferPatch · 只改 offer，不写 note、不动活动时间', () => {
  it('写薪资不碰 lastActivityAt / updatedAt / notes（沉默天数不归零）', () => {
    const db = makeDB();
    const notesBefore = db.notes.length;
    const activityBefore = db.applications[0].lastActivityAt;
    const ok = applyOfferPatch(db, 'a1', { monthlySalary: 20000, salaryMonths: 15 }, NOW_ISO);
    expect(ok).toBe(true);
    expect(db.applications[0].lastActivityAt).toBe(activityBefore);
    expect(db.notes).toHaveLength(notesBefore);
    expect(db.applications[0].offer).toEqual({
      monthlySalary: 20000,
      salaryMonths: 15,
      updatedAt: NOW_ISO,
    });
  });

  it('投递不存在 → 返回 false（调用方静默返回，不 toast）', () => {
    const db = makeDB();
    expect(applyOfferPatch(db, 'a-none', { monthlySalary: 1 }, NOW_ISO)).toBe(false);
  });

  it('传 null / undefined 是「清空该字段」：删键而不是写空串', () => {
    const db = makeDB();
    applyOfferPatch(db, 'a1', { monthlySalary: 20000, level: 'P5' }, NOW_ISO);
    applyOfferPatch(db, 'a1', { monthlySalary: null }, NOW_ISO);
    // 只剩 level + updatedAt：钱那一格被删掉，而不是写成 0 或空串
    expect(db.applications[0].offer).toEqual({ level: 'P5', updatedAt: NOW_ISO });
  });

  it('★ 清空到什么都不剩 → 整个 offer 键被删掉，不是留一个空壳', () => {
    const db = makeDB();
    applyOfferPatch(db, 'a1', { commuteMin: 35 }, NOW_ISO);
    applyOfferPatch(db, 'a1', { commuteMin: null }, NOW_ISO);
    expect('offer' in db.applications[0]).toBe(false);
  });

  it('patch 里没提到的字段保持原值（只改你想改的那一格）', () => {
    const db = makeDB();
    applyOfferPatch(db, 'a1', { monthlySalary: 20000, level: 'P5', commuteMin: 30 }, NOW_ISO);
    applyOfferPatch(db, 'a1', { level: 'P6' }, NOW_ISO);
    expect(db.applications[0].offer).toEqual({
      monthlySalary: 20000,
      level: 'P6',
      commuteMin: 30,
      updatedAt: NOW_ISO,
    });
  });

  it('payMode 非法值 → 删掉这个键（宁可回到缺省按月，也不存脏枚举）', () => {
    const db = makeDB();
    // 先垫一个别的字段，避免「只剩 updatedAt → 整块消失」把断言带偏
    applyOfferPatch(db, 'a1', { payMode: 'daily', dailyRate: 400 }, NOW_ISO);
    applyOfferPatch(db, 'a1', { payMode: null }, NOW_ISO);
    expect(db.applications[0].offer).toEqual({ dailyRate: 400, updatedAt: NOW_ISO });
  });

  it('scores：只收 1~5，勾掉的维度自动移除；全空则该键消失', () => {
    const db = makeDB();
    applyOfferPatch(db, 'a1', { monthlySalary: 20000, scores: { salary: 5, growth: 4 } }, NOW_ISO);
    expect(db.applications[0].offer?.scores).toEqual({ salary: 5, growth: 4 });
    applyOfferPatch(db, 'a1', { scores: null }, NOW_ISO);
    expect(db.applications[0].offer).toEqual({ monthlySalary: 20000, updatedAt: NOW_ISO });
  });

  it('scores 里出现非法值 → 丢弃该维，合法维保住', () => {
    const db = makeDB();
    applyOfferPatch(
      db,
      'a1',
      { scores: { salary: 0, growth: 4 } as unknown as Record<'salary' | 'growth', 1 | 2 | 3 | 4 | 5> },
      NOW_ISO,
    );
    expect(db.applications[0].offer?.scores).toEqual({ growth: 4 });
  });
});

describe('decisionViewOf · 悬空是设计的一部分', () => {
  it('没有决策 → null（不渲染回看卡）', () => {
    expect(decisionViewOf(makeDB(), undefined)).toBeNull();
  });

  it('决策指向的投递被删了 → 仍然能读，标签明确写「（投递已删除）」', () => {
    const db = makeDB();
    const decision: OfferDecision = {
      applicationId: 'a-ghost',
      decidedAt: '2026-11-01',
      reasonTags: ['薪资'],
      declinedIds: ['a2'],
    };
    const view = decisionViewOf(db, decision);
    expect(view?.app).toBeNull();
    expect(view?.companyLabel).toBe(DELETED_DECISION_LABEL);
    expect(view?.jobTitle).toBe('');
    expect(view?.declined[0]).toEqual({ id: 'a2', label: '美团 · 后端开发', alive: true });
  });

  it('★ 决策日只出绝对日期，绝不出相对文案（调系统时间也不影响）', () => {
    const db = makeDB();
    const view = decisionViewOf(db, {
      applicationId: 'a1',
      decidedAt: '2026-11-01',
      reasonTags: [],
    });
    expect(view?.decidedAtText).toBe('2026-11-01');
  });

  it('note 只露前 3 行（空行不计）', () => {
    const db = makeDB();
    const view = decisionViewOf(db, {
      applicationId: 'a1',
      decidedAt: '2026-11-01',
      reasonTags: [],
      note: '第一行\n\n  第二行  \n第三行\n第四行',
    });
    expect(view?.firstLines).toBe('第一行\n第二行\n第三行');
  });

  it('被放弃的投递后来被删了 → alive=false，标签说「这条投递已删除」', () => {
    const db = makeDB();
    const view = decisionViewOf(db, {
      applicationId: 'a1',
      decidedAt: '2026-11-01',
      reasonTags: [],
      declinedIds: ['a-ghost'],
    });
    expect(view?.declined[0]).toEqual({ id: 'a-ghost', label: '（这条投递已删除）', alive: false });
  });

  it('理由标签拼成一行，公司标签用简称', () => {
    const db = makeDB();
    const view = decisionViewOf(db, {
      applicationId: 'a1',
      decidedAt: '2026-11-01',
      reasonTags: ['薪资', '城市'],
    });
    expect(view?.companyLabel).toBe('字节');
    expect(view?.reasonText).toBe('薪资 · 城市');
  });
});

describe('decisionToMarkdown · OFF-10', () => {
  it('含标题 / 我选了 / 决策日 / 理由 / 放弃 / 权重 / 对比表 / 免责末行', () => {
    const db = makeDB();
    const view = decisionViewOf(db, {
      applicationId: 'a1',
      decidedAt: '2026-11-01',
      reasonTags: ['薪资'],
      note: '钱到位了',
      declinedIds: ['a2'],
    });
    if (!view) throw new Error('决策视图不该为空');
    const rows: CompareRow[] = [
      { key: 'total', label: '综合分', cells: [{ text: '74.0' }, { text: '—' }] },
    ];
    const markdown = decisionToMarkdown({
      view,
      rows,
      weights: { salary: 30, growth: 30, city: 20, wlb: 20 },
    });
    expect(markdown).toContain('# 我的 Offer 选择（2026-11-01）');
    expect(markdown).toContain('- 我选了：字节 · 前端开发');
    expect(markdown).toContain('- 为什么：薪资');
    expect(markdown).toContain('- 我放弃了：美团 · 后端开发');
    expect(markdown).toContain('- 权重：salary 30 / growth 30 / city 20 / wlb 20');
    expect(markdown).toContain('| 项目 | Offer 1 | Offer 2 |');
    expect(markdown).toContain('| 综合分 | 74.0 | — |');
    // ★ 末行必须留着：这句防止用户把工具当算命
    expect(markdown.trimEnd().endsWith('> 本地加权计算，仅供参考。')).toBe(true);
  });

  it('表格里的竖线与换行会被转义（否则导出的 Markdown 表格会散架）', () => {
    const db = makeDB();
    const view = decisionViewOf(db, { applicationId: 'a1', decidedAt: '2026-11-01', reasonTags: [] });
    if (!view) throw new Error('决策视图不该为空');
    const rows: CompareRow[] = [
      { key: 'equity', label: '股权', cells: [{ text: 'A | B\nC' }] },
    ];
    const markdown = decisionToMarkdown({ view, rows, weights: { salary: 100 } });
    expect(markdown).toContain('A \\| B C');
  });

  it('没有理由 / 没有放弃 / 没有表格时不留空标题', () => {
    const db = makeDB();
    const view = decisionViewOf(db, { applicationId: 'a1', decidedAt: '2026-11-01', reasonTags: [] });
    if (!view) throw new Error('决策视图不该为空');
    const markdown = decisionToMarkdown({
      view,
      rows: [],
      weights: { salary: 30, growth: 30, city: 20, wlb: 20 },
    });
    expect(markdown).not.toContain('- 为什么：');
    expect(markdown).not.toContain('- 我放弃了：');
    expect(markdown).not.toContain('| 项目 |');
  });
});
