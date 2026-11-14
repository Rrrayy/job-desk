/**
 * 模块一 · 四维加权分与权重再分配（纯函数，零 React / 零 IO）。
 *
 * 两条产品底线写在这里，组件层不许重算：
 * 1. **缺维不按 0 分参与**，而是「按已评维度归一」，并把 `normalized` 标出来 ——
 *    归一化会让「少打分」的 Offer 分数虚高，不标出来就会被当成 bug 报（R-04）。
 * 2. **权重四项和恒为 100 的整数**，拖动任一滑块后其余三项按原比例分摊。
 *    一次调完一直生效，所以它是「我的价值观」，不是「这次比较的临时参数」。
 */

import type { AppSettings, OfferDetail, OfferScoreKey } from '../../types';

/** 四维顺序：展示顺序 = 最大余数法/差额分摊的取先者顺序，禁止重排 */
export const OFFER_SCORE_KEYS: readonly OfferScoreKey[] = ['salary', 'growth', 'city', 'wlb'];

/** 权重总和（单位 %） */
export const OFFER_WEIGHT_TOTAL = 100;

/**
 * 缺省权重 30/30/20/20。
 * ★ 只活在这里，**不写进 `defaultSettings()`** —— 迁移若替用户写一份权重，
 *   「缺省即默认」就变成了「迁移替你决定价值观」（D-07 / 契约 3）。
 */
export const DEFAULT_OFFER_WEIGHTS: Record<OfferScoreKey, number> = {
  salary: 30,
  growth: 30,
  city: 20,
  wlb: 20,
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * 读出「本次生效」的权重：库里有合法值就用库里的，否则回落缺省。
 *
 * 合法性只要求「四项都是有限数」—— 和不为 100 时按比例归一（清洗层已经做过一次，
 * 这里再兜一次是为了防手工改库：宁可显示一组归一后的权重，也不要 NaN 把界面打穿）。
 */
export function offerWeightsOf(settings: AppSettings | undefined): Record<OfferScoreKey, number> {
  const raw = settings?.offerWeights;
  if (!raw) return { ...DEFAULT_OFFER_WEIGHTS };
  const values = OFFER_SCORE_KEYS.map((key) => clampInt(isFiniteNumber(raw[key]) ? raw[key] : NaN, 0, 100));
  if (values.some((value) => !Number.isFinite(value))) return { ...DEFAULT_OFFER_WEIGHTS };
  const sum = values.reduce((total, value) => total + value, 0);
  if (sum <= 0) return { ...DEFAULT_OFFER_WEIGHTS };
  if (sum === OFFER_WEIGHT_TOTAL) {
    return {
      salary: values[0],
      growth: values[1],
      city: values[2],
      wlb: values[3],
    };
  }
  return spreadToTotal(values, OFFER_WEIGHT_TOTAL);
}

/**
 * 把一组数值按比例分摊成「总和恰为 total 的整数」，且每项 ≥ 0。
 *
 * 算法（差额分摊）：先按比例向下取整，再把差额按**原值降序**逐项 +1（并列按入参顺序）。
 * 为什么不直接用纯最大余数法：文档给的验收向量是 `30/30/20/20 拖 salary→60 ⇒ 60/18/11/11`，
 * 而纯最大余数法（余数 .43 落在 city/wlb）会给出 17/12/11 —— 与验收向量不符。
 * 差额分摊是唯一同时满足「和为 total」「整数」「按原比例排序」且能复现该向量的取整方式。
 */
export function spreadToTotal(values: number[], total: number): Record<OfferScoreKey, number> {
  const safe = values.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  const sum = safe.reduce((acc, value) => acc + value, 0);
  const shares = safe.map((value) => (sum > 0 ? (value / sum) * total : total / safe.length));
  const floors = shares.map((share) => Math.max(0, Math.floor(share)));
  let deficit = total - floors.reduce((acc, value) => acc + value, 0);
  // 按原值降序（并列按原顺序）逐个 +1，直到补平；deficit 理论上 < 项数
  const order = safe
    .map((value, index) => ({ value, index }))
    .sort((a, b) => (b.value === a.value ? a.index - b.index : b.value - a.value))
    .map((item) => item.index);
  let cursor = 0;
  while (deficit > 0 && order.length > 0) {
    floors[order[cursor % order.length]] += 1;
    cursor += 1;
    deficit -= 1;
  }
  return {
    salary: floors[0] ?? 0,
    growth: floors[1] ?? 0,
    city: floors[2] ?? 0,
    wlb: floors[3] ?? 0,
  };
}

/** 某一维的贡献分（已评才有），= score/5 × weight，保留 1 位小数 */
export interface OfferScoreRow {
  key: OfferScoreKey;
  /** 0 = 未评 */
  score: number;
  weight: number;
  /** 该维贡献分（已评才有），= score/5 × weight，1 位小数 */
  contribution: number;
  rated: boolean;
}

export interface OfferScoreResult {
  /** 综合分 0–100（1 位小数）；一维未评都没有 = null（渲染 '—'，**不是 0**） */
  total: number | null;
  rows: OfferScoreRow[];
  /** 已评维度数 0–4 */
  ratedCount: number;
  /** 是否按已评维度归一（ratedCount 在 1..3） */
  normalized: boolean;
}

/**
 * 四维加权综合分（OFF-3 / OFF-4）。
 *
 * 公式（整数运算，杜绝浮点误差）：
 *   total = round( Σ(score_i × weight_i) × 200 / Σ(weight_i over 已评) ) / 10
 *
 * 校验向量：
 *   30/30/20/20 + 四维 5/5/5/5 → 100.0
 *   30/30/20/20 + 四维 3/4/5/2 → 70.0
 *   30/30/20/20 + 只评 salary=5, growth=5 → 100.0（归一，ratedCount=2）
 *   四维全未评 → null
 */
export function computeOfferScore(
  scores: Partial<Record<OfferScoreKey, 1 | 2 | 3 | 4 | 5>> | undefined,
  weights: Record<OfferScoreKey, number>,
): OfferScoreResult {
  const rows: OfferScoreRow[] = [];
  let weightedSum = 0;
  let ratedWeight = 0;
  let ratedCount = 0;

  for (const key of OFFER_SCORE_KEYS) {
    const raw = scores ? scores[key] : undefined;
    const rated = raw === 1 || raw === 2 || raw === 3 || raw === 4 || raw === 5;
    const score = rated ? (raw as number) : 0;
    const weight = clampInt(isFiniteNumber(weights[key]) ? weights[key] : 0, 0, OFFER_WEIGHT_TOTAL);
    rows.push({
      key,
      score,
      weight,
      // score × weight / 5，保留 1 位小数（整数算法：×2 再 round 再 /10）
      contribution: rated ? Math.round(score * weight * 2) / 10 : 0,
      rated,
    });
    if (rated) {
      weightedSum += score * weight;
      ratedWeight += weight;
      ratedCount += 1;
    }
  }

  const total =
    ratedCount === 0 || ratedWeight <= 0
      ? null
      : Math.round((weightedSum * 200) / ratedWeight) / 10;

  return {
    total,
    rows,
    ratedCount,
    normalized: ratedCount > 0 && ratedCount < OFFER_SCORE_KEYS.length,
  };
}

/**
 * 权重再分配（OFF-5）：把 key 拖到 value，其余三项**按原比例**分摊剩余值。
 *
 * 不变式（对任意拖动序列成立）：四项 ∈ [0,100] 整数且和恒为 100。
 * 边界：
 *   - value 四舍五入后 clamp 到 [0,100]
 *   - 其余三项原和为 0 → 平均分摊
 *   - 剩余值 < 待分摊项数 → 前面的项分到 1，其余 0，**不产生负数**
 *
 * 校验向量：30/30/20/20 拖 salary→60 ⇒ 60/18/11/11（PRD §3.1 OFF-5 原例）
 */
export function rebalanceWeights(
  weights: Record<OfferScoreKey, number>,
  key: OfferScoreKey,
  value: number,
): Record<OfferScoreKey, number> {
  const target = clampInt(isFiniteNumber(value) ? value : 0, 0, OFFER_WEIGHT_TOTAL);
  const rest = OFFER_WEIGHT_TOTAL - target;
  const others = OFFER_SCORE_KEYS.filter((item) => item !== key);
  const otherValues = others.map((item) => {
    const raw = weights[item];
    return isFiniteNumber(raw) && raw > 0 ? raw : 0;
  });
  const sumOthers = otherValues.reduce((acc, item) => acc + item, 0);
  // 其余三项原和为 0（或全是脏值）→ 平均分摊，仍走同一套取整
  const shares = otherValues.map((item) =>
    sumOthers > 0 ? (item / sumOthers) * rest : rest / others.length,
  );
  const floors = shares.map((share) => Math.max(0, Math.floor(share)));
  let deficit = rest - floors.reduce((acc, item) => acc + item, 0);
  const order = otherValues
    .map((item, index) => ({ value: item, index }))
    .sort((a, b) => (b.value === a.value ? a.index - b.index : b.value - a.value))
    .map((item) => item.index);
  let cursor = 0;
  while (deficit > 0 && order.length > 0) {
    floors[order[cursor % order.length]] += 1;
    cursor += 1;
    deficit -= 1;
  }

  const next: Record<OfferScoreKey, number> = { salary: 0, growth: 0, city: 0, wlb: 0 };
  next[key] = target;
  others.forEach((item, index) => {
    next[item] = floors[index];
  });
  return next;
}

/**
 * 年薪合计（派生，不落库）。
 * 只在「按月 + 月薪与薪数都有值」时计算：日薪折算依赖实际到岗天数，算出来反而误导。
 * 含签字费（它是一次性现金），**不含股权**（未上市股权的价值取决于你信不信那个估值）。
 */
export function annualTotalOf(offer: OfferDetail | undefined): number | null {
  if (!offer) return null;
  if (offer.payMode === 'daily') return null;
  const salary = offer.monthlySalary;
  const months = offer.salaryMonths;
  if (!isFiniteNumber(salary) || !isFiniteNumber(months)) return null;
  if (salary <= 0 || months <= 0) return null;
  const bonus = isFiniteNumber(offer.signOnBonus) && offer.signOnBonus > 0 ? offer.signOnBonus : 0;
  return Math.round(salary * months + bonus);
}

/** 万元文案：405000 → '40.5'；400000 → '40' */
function toWan(total: number): string {
  const value = Math.round(total / 1000) / 10;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * 年薪合计的三种文案都在这里，UI 只负责渲染，不拼字符串：
 * '40.5 万（不含股权）' / '不能算（日薪）' / '薪资未填'
 */
export function annualTotalText(offer: OfferDetail | undefined): string {
  if (!offer) return '薪资未填';
  if (offer.payMode === 'daily') return '不能算（日薪）';
  const total = annualTotalOf(offer);
  if (total === null) return '薪资未填';
  const equity = (offer.equityText || '').trim();
  return equity ? `${toWan(total)} 万（不含股权）` : `${toWan(total)} 万`;
}

/** 「还有 N 维没评」的 N（0 = 不缺） */
export function missingScoreCount(offer: OfferDetail | undefined): number {
  const scores = offer?.scores;
  let rated = 0;
  for (const key of OFFER_SCORE_KEYS) {
    const value = scores ? scores[key] : undefined;
    if (value === 1 || value === 2 || value === 3 || value === 4 || value === 5) rated += 1;
  }
  return OFFER_SCORE_KEYS.length - rated;
}
