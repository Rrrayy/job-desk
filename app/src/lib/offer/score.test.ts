/**
 * 模块一 · 加权分与权重再分配的校验向量（PRD §3.1 OFF-3 / OFF-4 / OFF-5）。
 *
 * 这几条数字是**产品验收向量**，不是「实现算出来什么就是什么」：
 * 评分口径一旦跑偏，用户看到的就是「工具替我排了个我不认的序」。
 */

import { describe, expect, it } from 'vitest';
import type { OfferScoreKey } from '../../types';
import {
  DEFAULT_OFFER_WEIGHTS,
  OFFER_SCORE_KEYS,
  OFFER_WEIGHT_TOTAL,
  annualTotalOf,
  annualTotalText,
  computeOfferScore,
  missingScoreCount,
  offerWeightsOf,
  rebalanceWeights,
  spreadToTotal,
} from './score';

const W = DEFAULT_OFFER_WEIGHTS;

/** 求和，断言「权重恒为 100」这个不变式 */
function sumOf(weights: Record<OfferScoreKey, number>): number {
  return OFFER_SCORE_KEYS.reduce((acc, key) => acc + weights[key], 0);
}

describe('computeOfferScore · 校验向量', () => {
  it('30/30/20/20 + 四维 5/5/5/5 → 100.0', () => {
    const result = computeOfferScore({ salary: 5, growth: 5, city: 5, wlb: 5 }, W);
    expect(result.total).toBe(100);
    expect(result.ratedCount).toBe(4);
    expect(result.normalized).toBe(false);
  });

  it('30/30/20/20 + 四维 3/4/5/2 → 70.0', () => {
    const result = computeOfferScore({ salary: 3, growth: 4, city: 5, wlb: 2 }, W);
    expect(result.total).toBe(70);
    expect(result.ratedCount).toBe(4);
  });

  it('★ 只评两维（都 5 分）→ 归一后仍是 100.0，且 normalized 标记为 true', () => {
    const result = computeOfferScore({ salary: 5, growth: 5 }, W);
    expect(result.total).toBe(100);
    expect(result.ratedCount).toBe(2);
    expect(result.normalized).toBe(true);
  });

  it('★ 四维全未评 → total 是 null（渲染「—」），不是 0', () => {
    const result = computeOfferScore(undefined, W);
    expect(result.total).toBeNull();
    expect(result.ratedCount).toBe(0);
    expect(result.normalized).toBe(false);
    expect(result.rows.every((row) => !row.rated)).toBe(true);
  });

  it('归一化会让「少打分」虚高 —— 这是设计取舍，必须能被测试看见（R-04）', () => {
    // 只给 city 打 1 分：归一后 = 20.0，而不是「按四维算」的 4.0
    const onlyCity = computeOfferScore({ city: 1 }, W);
    expect(onlyCity.total).toBe(20);
    expect(onlyCity.normalized).toBe(true);
  });

  it('逐维贡献分 = score/5 × weight，保留 1 位小数', () => {
    const result = computeOfferScore({ salary: 3, growth: 4, city: 5, wlb: 2 }, W);
    const byKey = new Map(result.rows.map((row) => [row.key, row]));
    expect(byKey.get('salary')?.contribution).toBe(18);
    expect(byKey.get('growth')?.contribution).toBe(24);
    expect(byKey.get('city')?.contribution).toBe(20);
    expect(byKey.get('wlb')?.contribution).toBe(8);
  });

  it('未评的维度贡献分是 0、weight 仍然照实展示（用户要知道那一维占多少）', () => {
    const result = computeOfferScore({ salary: 5 }, W);
    const growth = result.rows.find((row) => row.key === 'growth');
    expect(growth?.rated).toBe(false);
    expect(growth?.contribution).toBe(0);
    expect(growth?.score).toBe(0);
    expect(growth?.weight).toBe(30);
  });

  it('权重全为 0 时 total 是 null（除以 0 保护，不出 NaN）', () => {
    const zeros: Record<OfferScoreKey, number> = { salary: 0, growth: 0, city: 0, wlb: 0 };
    expect(computeOfferScore({ salary: 5 }, zeros).total).toBeNull();
  });

  it('非法权重（NaN / 负数 / 超 100）被 clamp，不产生 NaN 分', () => {
    const dirty = { salary: NaN, growth: -10, city: 300, wlb: 20 } as unknown as Record<
      OfferScoreKey,
      number
    >;
    const result = computeOfferScore({ salary: 5, growth: 5, city: 5, wlb: 5 }, dirty);
    expect(Number.isNaN(result.total as number)).toBe(false);
    const byKey = new Map(result.rows.map((row) => [row.key, row.weight]));
    expect(byKey.get('salary')).toBe(0);
    expect(byKey.get('growth')).toBe(0);
    expect(byKey.get('city')).toBe(100);
    expect(byKey.get('wlb')).toBe(20);
  });
});

describe('rebalanceWeights · 拖一个滑块，其余按原比例分摊', () => {
  it('★ 验收向量：30/30/20/20 拖 salary→60 ⇒ 60/18/11/11', () => {
    expect(rebalanceWeights(W, 'salary', 60)).toEqual({ salary: 60, growth: 18, city: 11, wlb: 11 });
  });

  it('★ 不变式：任意拖动序列，四项都是 [0,100] 整数且和恒为 100', () => {
    let weights: Record<OfferScoreKey, number> = { ...W };
    const sequence: Array<[OfferScoreKey, number]> = [
      ['growth', 0],
      ['growth', 100],
      ['city', 33],
      ['wlb', 7],
      ['salary', 0],
      ['city', 1],
      ['wlb', 99],
      ['growth', 50],
    ];
    for (const [key, value] of sequence) {
      weights = rebalanceWeights(weights, key, value);
      expect(sumOf(weights)).toBe(OFFER_WEIGHT_TOTAL);
      for (const dim of OFFER_SCORE_KEYS) {
        expect(Number.isInteger(weights[dim])).toBe(true);
        expect(weights[dim]).toBeGreaterThanOrEqual(0);
        expect(weights[dim]).toBeLessThanOrEqual(OFFER_WEIGHT_TOTAL);
      }
    }
  });

  it('拖到 100 → 其余全 0；拖到 0 → 100 全分给其余三项（按 30:20:20 分摊 ⇒ 43:29:28）', () => {
    expect(rebalanceWeights(W, 'salary', 100)).toEqual({ salary: 100, growth: 0, city: 0, wlb: 0 });
    expect(rebalanceWeights(W, 'salary', 0)).toEqual({ salary: 0, growth: 43, city: 29, wlb: 28 });
  });

  it('越界值先 clamp：拖到 130 → 100，拖到 -20 → 0', () => {
    expect(rebalanceWeights(W, 'salary', 130).salary).toBe(100);
    expect(rebalanceWeights(W, 'salary', -20).salary).toBe(0);
  });

  it('其余三项原本全 0 → 平均分摊（不除以 0，也不产生负数）', () => {
    const weights = rebalanceWeights({ salary: 100, growth: 0, city: 0, wlb: 0 }, 'salary', 40);
    expect(sumOf(weights)).toBe(100);
    expect(weights.salary).toBe(40);
    expect(weights.growth + weights.city + weights.wlb).toBe(60);
  });

  it('剩余值小于待分摊项数时，前面的项各分到 1，其余 0（不出负数）', () => {
    const weights = rebalanceWeights({ salary: 0, growth: 34, city: 33, wlb: 33 }, 'salary', 98);
    expect(weights.salary).toBe(98);
    expect(sumOf(weights)).toBe(100);
    expect(Math.min(weights.growth, weights.city, weights.wlb)).toBeGreaterThanOrEqual(0);
  });
});

describe('rebalanceWeights · 属性测试（v1.0.0 补：随机拖动几百组）', () => {
  /**
   * 可复现的伪随机（线性同余）：不用 Math.random —— 失败时要能一条命令复跑出同一组序列。
   * 断言的是 PRD OFF-5 的原话：**对任意拖动序列，四项和为 100 且每项为 0–100 整数**。
   */
  function lcg(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  it('★ 300 组随机序列 × 每序列 6 次拖动：和恒为 100、每项 0–100 整数', () => {
    const rand = lcg(20260312);
    for (let round = 0; round < 300; round += 1) {
      let weights: Record<OfferScoreKey, number> = { ...W };
      for (let step = 0; step < 6; step += 1) {
        const key = OFFER_SCORE_KEYS[Math.floor(rand() * OFFER_SCORE_KEYS.length)];
        // 覆盖「正常值 + 越界值 + 小数」三类输入
        const roll = rand();
        const value = roll < 0.1 ? -5 : roll < 0.2 ? 130 : Math.round(rand() * 1000) / 10;
        weights = rebalanceWeights(weights, key, value);
        expect(sumOf(weights)).toBe(OFFER_WEIGHT_TOTAL);
        for (const dim of OFFER_SCORE_KEYS) {
          expect(Number.isInteger(weights[dim])).toBe(true);
          expect(weights[dim]).toBeGreaterThanOrEqual(0);
          expect(weights[dim]).toBeLessThanOrEqual(OFFER_WEIGHT_TOTAL);
        }
      }
    }
  });

  it('★ 余数相等时的取先顺序沿用 salary → growth → city → wlb（PRD OFF-5 原话）', () => {
    // 30/30/20/20 把 wlb 拖到 40：其余三项按 30:30:20 分摊 60
    // → 理论 22.5 / 22.5 / 15，floor 后差 1，并列的 salary 与 growth 里取先者 salary
    expect(rebalanceWeights(W, 'wlb', 40)).toEqual({ salary: 23, growth: 22, city: 15, wlb: 40 });
    // 同一向量换个方向再验一次：40/20/20/20 把 growth 拖到 30 → 其余 70 按 40:20:20 分摊
    // → 理论 35 / 17.5 / 17.5，floor 后差 1，按原值降序先补给 salary ⇒ 36 / 17 / 17
    const from = { salary: 40, growth: 20, city: 20, wlb: 20 } as Record<OfferScoreKey, number>;
    expect(rebalanceWeights(from, 'growth', 30)).toEqual({ salary: 36, growth: 30, city: 17, wlb: 17 });
  });
});

describe('spreadToTotal · 整数分摊', () => {
  it('总和恒等于 total，且每项 ≥ 0', () => {
    const cases: number[][] = [
      [45, 45, 0, 0],
      [1, 1, 1, 1],
      [99, 0, 0, 0],
      [0, 0, 0, 0],
      [7, 13, 29, 51],
    ];
    for (const values of cases) {
      const weights = spreadToTotal(values, 100);
      expect(sumOf(weights)).toBe(100);
      for (const dim of OFFER_SCORE_KEYS) expect(weights[dim]).toBeGreaterThanOrEqual(0);
    }
  });

  it('全是 0 → 平均分摊 25/25/25/25', () => {
    expect(spreadToTotal([0, 0, 0, 0], 100)).toEqual({ salary: 25, growth: 25, city: 25, wlb: 25 });
  });
});

describe('offerWeightsOf · 读生效权重（脏库兜底）', () => {
  it('没有 settings / 没有 offerWeights → 缺省 30/30/20/20', () => {
    expect(offerWeightsOf(undefined)).toEqual(DEFAULT_OFFER_WEIGHTS);
    expect(offerWeightsOf({} as never)).toEqual(DEFAULT_OFFER_WEIGHTS);
  });

  it('库里有合法值 → 用它（一次调完一直生效 = 这是「我的价值观」）', () => {
    const settings = { offerWeights: { salary: 50, growth: 20, city: 20, wlb: 10 } } as never;
    expect(offerWeightsOf(settings)).toEqual({ salary: 50, growth: 20, city: 20, wlb: 10 });
  });

  it('手工改库导致和不为 100 → 归一后仍然可用（不让 NaN 打穿界面）', () => {
    const settings = { offerWeights: { salary: 45, growth: 45, city: 0, wlb: 0 } } as never;
    const weights = offerWeightsOf(settings);
    expect(weights).toEqual({ salary: 50, growth: 50, city: 0, wlb: 0 });
  });

  it('脏值（缺维 / 全 0）→ 回落缺省', () => {
    expect(offerWeightsOf({ offerWeights: { salary: 50 } } as never)).toEqual(DEFAULT_OFFER_WEIGHTS);
    expect(
      offerWeightsOf({ offerWeights: { salary: 0, growth: 0, city: 0, wlb: 0 } } as never),
    ).toEqual(DEFAULT_OFFER_WEIGHTS);
  });
});

describe('年薪与缺维提示', () => {
  it('月薪 × 薪数 + 签字费，股权不计', () => {
    expect(annualTotalOf({ monthlySalary: 20000, salaryMonths: 15, updatedAt: '' })).toBe(300000);
    expect(
      annualTotalOf({ monthlySalary: 20000, salaryMonths: 15, signOnBonus: 10000, updatedAt: '' }),
    ).toBe(310000);
  });

  it('日薪口径不算年薪（依赖实际到岗天数，算出来反而误导）', () => {
    expect(annualTotalOf({ payMode: 'daily', dailyRate: 400, updatedAt: '' })).toBeNull();
  });

  it('缺月薪或缺薪数 → null', () => {
    expect(annualTotalOf({ monthlySalary: 20000, updatedAt: '' })).toBeNull();
    expect(annualTotalOf({ salaryMonths: 15, updatedAt: '' })).toBeNull();
    expect(annualTotalOf(undefined)).toBeNull();
  });

  it('三种文案：40.5 万（不含股权）/ 不能算（日薪）/ 薪资未填', () => {
    expect(
      annualTotalText({ monthlySalary: 20000, salaryMonths: 15, equityText: '5000 股', updatedAt: '' }),
    ).toBe('30 万（不含股权）');
    expect(
      annualTotalText({ monthlySalary: 20000, salaryMonths: 15, updatedAt: '' }),
    ).toBe('30 万');
    expect(annualTotalText({ payMode: 'daily', dailyRate: 400, updatedAt: '' })).toBe('不能算（日薪）');
    expect(annualTotalText(undefined)).toBe('薪资未填');
  });

  it('年薪取整到 0.1 万：405000 → 40.5 万；400000 → 40 万', () => {
    expect(annualTotalText({ monthlySalary: 27000, salaryMonths: 15, updatedAt: '' })).toBe('40.5 万');
    expect(
      annualTotalText({ monthlySalary: 25000, salaryMonths: 16, updatedAt: '' }),
    ).toBe('40 万');
  });

  it('missingScoreCount：0 = 不缺，4 = 全未评', () => {
    expect(missingScoreCount(undefined)).toBe(4);
    expect(missingScoreCount({ updatedAt: '' })).toBe(4);
    expect(missingScoreCount({ scores: { salary: 3 }, updatedAt: '' })).toBe(3);
    expect(
      missingScoreCount({ scores: { salary: 3, growth: 3, city: 3, wlb: 3 }, updatedAt: '' }),
    ).toBe(0);
  });
});
