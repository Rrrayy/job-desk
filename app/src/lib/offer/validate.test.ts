/**
 * Offer 清洗层（PRD §4.6）的契约测试。
 *
 * 这一层是「坏备份能不能进库」的唯一闸门，所以每条断言都对着一条产品口径：
 * 不造空壳 / 能截断的截断 / 越界的清空该字段 / 整条不认识才丢弃。
 */

import { describe, expect, it } from 'vitest';
import { normalizeOfferDecision, normalizeOfferDetail, normalizeOfferWeights } from './validate';

const NOW = '2026-11-01T00:00:00.000Z';

describe('normalizeOfferDetail · 不造内容', () => {
  it('非对象一律 null', () => {
    expect(normalizeOfferDetail(undefined, NOW)).toBeNull();
    expect(normalizeOfferDetail(null, NOW)).toBeNull();
    expect(normalizeOfferDetail('月薪 2 万', NOW)).toBeNull();
    expect(normalizeOfferDetail([], NOW)).toBeNull();
    expect(normalizeOfferDetail(42, NOW)).toBeNull();
  });

  it('只有 updatedAt、或者只有不认识的键 → null（不返回 {updatedAt} 空壳）', () => {
    expect(normalizeOfferDetail({ updatedAt: '2026-10-01T00:00:00.000Z' }, NOW)).toBeNull();
    expect(normalizeOfferDetail({ foo: 1, bar: 'x' }, NOW)).toBeNull();
  });

  it('一个有效字段都没有（全是坏值）→ null', () => {
    expect(
      normalizeOfferDetail({ monthlySalary: '两万', salaryMonths: 99, commuteMin: -5, scores: {} }, NOW),
    ).toBeNull();
  });
});

describe('normalizeOfferDetail · 逐字段', () => {
  it('九字段齐全 → 原样落库，updatedAt 沿用合法输入值', () => {
    const detail = normalizeOfferDetail(
      {
        payMode: 'monthly',
        monthlySalary: 20000,
        salaryMonths: 15,
        signOnBonus: 0,
        equityText: '  期权 5000 股（4 年）  ',
        level: 'P5',
        commuteMin: 35,
        scores: { salary: 5, growth: 4, city: 3, wlb: 2 },
        notes: '12 月统一发放年终',
        updatedAt: '2026-10-21T09:00:00.000Z',
      },
      NOW,
    );
    expect(detail).toEqual({
      payMode: 'monthly',
      monthlySalary: 20000,
      salaryMonths: 15,
      // ★ 签字费 0 ≠ 未填，必须保留
      signOnBonus: 0,
      equityText: '期权 5000 股（4 年）',
      level: 'P5',
      commuteMin: 35,
      scores: { salary: 5, growth: 4, city: 3, wlb: 2 },
      notes: '12 月统一发放年终',
      updatedAt: '2026-10-21T09:00:00.000Z',
    });
  });

  it('updatedAt 形状不合法 → 回落 nowIso（它是唯一必填字段）', () => {
    const detail = normalizeOfferDetail({ monthlySalary: 12000, updatedAt: '2026-13-45' }, NOW);
    expect(detail?.updatedAt).toBe(NOW);
  });

  it('数值越界 → 只清空该字段，不整条丢弃', () => {
    const detail = normalizeOfferDetail(
      { monthlySalary: -1, salaryMonths: 25, commuteMin: 300, level: 'T1.2' },
      NOW,
    );
    expect(detail).toEqual({ level: 'T1.2', updatedAt: NOW });
  });

  it('小数取整（月薪 19999.6 → 20000；薪数 15.4 → 15）', () => {
    const detail = normalizeOfferDetail({ monthlySalary: 19999.6, salaryMonths: 15.4 }, NOW);
    expect(detail?.monthlySalary).toBe(20000);
    expect(detail?.salaryMonths).toBe(15);
  });

  it('薪数下限 12：11 个月不是「少发一个月」，是脏数据', () => {
    expect(normalizeOfferDetail({ salaryMonths: 11 }, NOW)).toBeNull();
    expect(normalizeOfferDetail({ salaryMonths: 12 }, NOW)?.salaryMonths).toBe(12);
  });

  it('日薪与 payMode=daily 一起保留（日薪口径不折算年薪，但本身要能存）', () => {
    const detail = normalizeOfferDetail({ payMode: 'daily', dailyRate: 400 }, NOW);
    expect(detail).toEqual({ payMode: 'daily', dailyRate: 400, updatedAt: NOW });
  });

  it('payMode 只认 monthly / daily，别的值丢弃但其余字段照留', () => {
    const detail = normalizeOfferDetail({ payMode: 'yearly', monthlySalary: 9000 }, NOW);
    expect(detail).toEqual({ monthlySalary: 9000, updatedAt: NOW });
  });

  it('长文本截断而不是丢弃：股权 60 字、补充说明 200 字', () => {
    const detail = normalizeOfferDetail(
      { equityText: '股'.repeat(100), notes: '注'.repeat(300) },
      NOW,
    );
    expect(detail?.equityText).toHaveLength(60);
    expect(detail?.notes).toHaveLength(200);
  });

  it('纯空白文本视为未填（不会写成空串占位）', () => {
    expect(normalizeOfferDetail({ equityText: '   ', notes: '\n' }, NOW)).toBeNull();
  });

  it('四维分只认 1~5 的整数，未知维度直接丢弃', () => {
    const detail = normalizeOfferDetail(
      { scores: { salary: 0, growth: 6, city: 4, wlb: 4.6, bogus: 5 } },
      NOW,
    );
    // city 4 合法保留；wlb 4.6 → 四舍五入 5；salary 0 / growth 6 / 未知键 bogus 都丢弃
    expect(detail?.scores).toEqual({ city: 4, wlb: 5 });
  });

  it('scores 一个合法值都没有 → 不写 scores 键（缺 = 未评）', () => {
    const detail = normalizeOfferDetail({ monthlySalary: 8000, scores: { salary: 0 } }, NOW);
    expect(detail).not.toBeNull();
    expect('scores' in (detail as object)).toBe(false);
  });
});

describe('normalizeOfferDecision · 单例决策', () => {
  it('非对象 / 缺 applicationId / decidedAt 不是 YYYY-MM-DD → null（整条丢弃）', () => {
    expect(normalizeOfferDecision(undefined)).toBeNull();
    expect(normalizeOfferDecision({ decidedAt: '2026-11-01' })).toBeNull();
    expect(normalizeOfferDecision({ applicationId: 'a1' })).toBeNull();
    expect(normalizeOfferDecision({ applicationId: 'a1', decidedAt: '2026-11-1' })).toBeNull();
    expect(normalizeOfferDecision({ applicationId: '   ', decidedAt: '2026-11-01' })).toBeNull();
  });

  it('★ 悬空 applicationId 故意放行（校验它会让「删投递 → 导出 → 导入」整库失败）', () => {
    const decision = normalizeOfferDecision({
      applicationId: 'app-already-deleted',
      decidedAt: '2026-11-01',
      reasonTags: ['薪资'],
    });
    expect(decision).toEqual({
      applicationId: 'app-already-deleted',
      decidedAt: '2026-11-01',
      reasonTags: ['薪资'],
    });
  });

  it('理由标签去空、去重、超长截断、最多 5 个', () => {
    const decision = normalizeOfferDecision({
      applicationId: 'a1',
      decidedAt: '2026-11-01',
      reasonTags: ['  薪资 ', '', '薪资', '一二三四五六七八九十十一', '成长', '城市', 'WLB', '团队', '品牌'],
      note: '  离家近，团队氛围好  ',
    });
    expect(decision?.reasonTags).toEqual(['薪资', '一二三四五六七八九十', '成长', '城市', 'WLB']);
    expect(decision?.note).toBe('离家近，团队氛围好');
  });

  it('declinedIds 去重、剔除自己、非字符串跳过；空了就不写这个键', () => {
    const decision = normalizeOfferDecision({
      applicationId: 'a1',
      decidedAt: '2026-11-01',
      declinedIds: ['a2', 'a2', 'a1', '  ', 3, 'a3'],
    });
    expect(decision?.declinedIds).toEqual(['a2', 'a3']);

    const empty = normalizeOfferDecision({ applicationId: 'a1', decidedAt: '2026-11-01', declinedIds: [] });
    expect('declinedIds' in (empty as object)).toBe(false);
  });

  it('note 截断到 500 字', () => {
    const decision = normalizeOfferDecision({
      applicationId: 'a1',
      decidedAt: '2026-11-01',
      note: '字'.repeat(600),
    });
    expect(decision?.note).toHaveLength(500);
  });
});

describe('normalizeOfferWeights · 缺省即默认', () => {
  it('非对象 → null（这是「不存在」，不是「归零」）', () => {
    expect(normalizeOfferWeights(undefined)).toBeNull();
    expect(normalizeOfferWeights(null)).toBeNull();
    expect(normalizeOfferWeights('30/30/20/20')).toBeNull();
  });

  it('缺任一维 / 任一维不是有限数 → null', () => {
    expect(normalizeOfferWeights({ salary: 30, growth: 30, city: 40 })).toBeNull();
    expect(normalizeOfferWeights({ salary: 30, growth: 30, city: 20, wlb: '20' })).toBeNull();
    expect(normalizeOfferWeights({ salary: 30, growth: 30, city: 20, wlb: NaN })).toBeNull();
  });

  it('和恰为 100 且都在范围内 → 原样返回，没有 warning', () => {
    expect(normalizeOfferWeights({ salary: 30, growth: 30, city: 20, wlb: 20 })).toEqual({
      weights: { salary: 30, growth: 30, city: 20, wlb: 20 },
    });
    expect(normalizeOfferWeights({ salary: 50, growth: 50, city: 0, wlb: 0 })).toEqual({
      weights: { salary: 50, growth: 50, city: 0, wlb: 0 },
    });
  });

  it('和不为 100 → 按比例归一到 100，并给一句 warning（不阻断导入）', () => {
    const result = normalizeOfferWeights({ salary: 45, growth: 45, city: 0, wlb: 0 });
    expect(result?.weights).toEqual({ salary: 50, growth: 50, city: 0, wlb: 0 });
    expect(result?.warning).toContain('已按比例归一到 100');
  });

  it('单项越界先 clamp 再归一（-10 / 110 → 0 / 100），仍然给出 warning', () => {
    const result = normalizeOfferWeights({ salary: -10, growth: 110, city: 0, wlb: 0 });
    expect(result?.weights).toEqual({ salary: 0, growth: 100, city: 0, wlb: 0 });
    expect(result?.warning).toBeTruthy();
  });

  it('四项全 0 → null（全 0 权重算不出任何分，等同于没有权重）', () => {
    expect(normalizeOfferWeights({ salary: 0, growth: 0, city: 0, wlb: 0 })).toBeNull();
  });

  it('小数权重先取整再判断和', () => {
    expect(normalizeOfferWeights({ salary: 30.4, growth: 30.4, city: 19.6, wlb: 19.6 })).toEqual({
      weights: { salary: 30, growth: 30, city: 20, wlb: 20 },
    });
  });
});
