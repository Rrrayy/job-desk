/**
 * 模块一 · Offer 相关的白名单式清洗（PRD §4.6 的十一条规则里属于 Offer 的九条）。
 *
 * 三条口径：
 * 1. **不造内容**：一个有效字段都没有 → 返回 null，不返回 `{ updatedAt }` 空壳。
 *    「缺省即不存在」是「删投递 → 导出 → 导入」能整库往返的前提。
 * 2. **不静默丢**：能截断的（文本类）截断，能清的（数值越界）清空该字段；
 *    只有「整个对象都不认识」才返回 null。
 * 3. `applicationId` 的悬空**故意不校验**（D-14）—— 校验它会让「删投递 → 导出 → 导入」整库失败。
 */

import type { OfferDecision, OfferDetail, OfferPayMode, OfferScoreKey } from '../../types';
import { OFFER_SCORE_KEYS, spreadToTotal, OFFER_WEIGHT_TOTAL } from './score';
import { DECISION_NOTE_LIMIT, sanitizeReasonTags } from './decision';

/** 本文件自带一份 isRecord，避免与 validateV1 形成运行时循环依赖（它反过来要 import 这里） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.slice(0, limit);
}

/** 有限非负整数，且 ≤ 上限；越界返回 undefined（清空该字段，不阻断导入） */
function asIntInRange(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) return undefined;
  return rounded;
}

const MAX_MONEY = 1_000_000;

/**
 * 归一化一份 `Application.offer`。返回 null = 没有任何有效字段（不造空对象）。
 * `nowIso` 只用于补 `updatedAt` —— 它是唯一必填字段，也是一处唯一允许填时间的地方。
 */
export function normalizeOfferDetail(raw: unknown, nowIso: string): OfferDetail | null {
  if (!isRecord(raw)) return null;

  const detail: OfferDetail = { updatedAt: nowIso };
  let filled = 0;

  const payMode = raw.payMode;
  if (payMode === 'monthly' || payMode === 'daily') {
    detail.payMode = payMode as OfferPayMode;
    filled += 1;
  }

  const monthlySalary = asIntInRange(raw.monthlySalary, 0, MAX_MONEY);
  if (monthlySalary !== undefined) {
    detail.monthlySalary = monthlySalary;
    filled += 1;
  }
  const salaryMonths = asIntInRange(raw.salaryMonths, 12, 24);
  if (salaryMonths !== undefined) {
    detail.salaryMonths = salaryMonths;
    filled += 1;
  }
  const dailyRate = asIntInRange(raw.dailyRate, 0, MAX_MONEY);
  if (dailyRate !== undefined) {
    detail.dailyRate = dailyRate;
    filled += 1;
  }
  const signOnBonus = asIntInRange(raw.signOnBonus, 0, MAX_MONEY);
  if (signOnBonus !== undefined) {
    detail.signOnBonus = signOnBonus;
    filled += 1;
  }
  const commuteMin = asIntInRange(raw.commuteMin, 0, 240);
  if (commuteMin !== undefined) {
    detail.commuteMin = commuteMin;
    filled += 1;
  }

  const equityText = asText(raw.equityText, 60);
  if (equityText) {
    detail.equityText = equityText;
    filled += 1;
  }
  const level = asText(raw.level, 40);
  if (level) {
    detail.level = level;
    filled += 1;
  }
  const notes = asText(raw.notes, 200);
  if (notes) {
    detail.notes = notes;
    filled += 1;
  }

  if (isRecord(raw.scores)) {
    const scores: Partial<Record<OfferScoreKey, 1 | 2 | 3 | 4 | 5>> = {};
    for (const key of OFFER_SCORE_KEYS) {
      const value = raw.scores[key];
      const score = asIntInRange(value, 1, 5);
      if (score !== undefined) scores[key] = score as 1 | 2 | 3 | 4 | 5;
    }
    // 未知 key 直接丢弃（白名单式读取，不需要遍历原对象）
    if (Object.keys(scores).length > 0) {
      detail.scores = scores;
      filled += 1;
    }
  }

  if (filled === 0) return null;
  // updatedAt 只认合法的 ISO；形状不对就回落 nowIso（别的字段都允许缺失，它不行）
  if (typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt))) {
    detail.updatedAt = raw.updatedAt;
  }
  return detail;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** 归一化 `db.offerDecision`。缺 applicationId 或 decidedAt 形状不对 → null（整条丢弃） */
export function normalizeOfferDecision(raw: unknown): OfferDecision | null {
  if (!isRecord(raw)) return null;
  const applicationId = typeof raw.applicationId === 'string' ? raw.applicationId.trim() : '';
  const decidedAt = typeof raw.decidedAt === 'string' ? raw.decidedAt.trim() : '';
  if (!applicationId || !DATE_ONLY.test(decidedAt)) return null;

  const decision: OfferDecision = {
    applicationId,
    decidedAt,
    reasonTags: sanitizeReasonTags(raw.reasonTags),
  };
  const note = asText(raw.note, DECISION_NOTE_LIMIT);
  if (note) decision.note = note;
  if (Array.isArray(raw.declinedIds)) {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const item of raw.declinedIds) {
      if (typeof item !== 'string') continue;
      const id = item.trim();
      if (!id || id === applicationId || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    if (ids.length > 0) decision.declinedIds = ids;
  }
  return decision;
}

/**
 * 归一化 `settings.offerWeights`。null = 「不存在」（不是「归零」—— 两者在语义上完全不同）。
 * 单项越界先 clamp，和 ≠ 100 再按比例归一，并返回一句 warning（不阻断导入）。
 */
export function normalizeOfferWeights(
  raw: unknown,
): { weights: Record<OfferScoreKey, number>; warning?: string } | null {
  if (!isRecord(raw)) return null;
  const values: number[] = [];
  let outOfRange = false;
  for (const key of OFFER_SCORE_KEYS) {
    const value = raw[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const rounded = Math.round(value);
    if (rounded < 0 || rounded > OFFER_WEIGHT_TOTAL) outOfRange = true;
    values.push(Math.min(OFFER_WEIGHT_TOTAL, Math.max(0, rounded)));
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  if (sum <= 0) return null;
  if (sum === OFFER_WEIGHT_TOTAL && !outOfRange) {
    return {
      weights: { salary: values[0], growth: values[1], city: values[2], wlb: values[3] },
    };
  }
  return {
    weights: spreadToTotal(values, OFFER_WEIGHT_TOTAL),
    warning: `四维权重之和是 ${sum}，已按比例归一到 100`,
  };
}
