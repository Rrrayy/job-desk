/**
 * 模块一 · 对比候选集与对比表行模型（纯函数，零 React / 零 IO）。
 *
 * 「对比」这件事的两个产品判断写在这里：
 * 1. **候选集只看状态**（`offer` / `onboarded`），不看有没有填薪资 ——
 *    刚拿到口头 offer 时用户什么都不知道，这时候最需要并排看。
 * 2. 综合分下面必须**摊开每一维的贡献**。只给一个总分就是「黑箱替你排序」。
 */

import type { AppSettings, Application, Company, DB, OfferDetail, OfferScoreKey } from '../../types';
import {
  buildNoteIndex,
  deadlineStateOf,
  silenceStateOf,
  type DeadlineState,
  type SilenceState,
} from '../rules';
import { daysBetween, fmtDate } from '../date';
import {
  annualTotalText,
  computeOfferScore,
  missingScoreCount,
  offerWeightsOf,
  OFFER_SCORE_KEYS,
  type OfferScoreResult,
} from './score';

/** 同时对比的投递上限（超过就只能横向滚动，8 列已是 1120px 的极限） */
export const MAX_COMPARE = 8;

export interface OfferCandidate {
  app: Application;
  company: Company | undefined;
  offer: OfferDetail | undefined;
  score: OfferScoreResult;
  deadline: DeadlineState;
  silence: SilenceState;
}

export interface CompareCell {
  text: string;
  tone?: 'muted' | 'warn' | 'primary';
  /** 格内补充说明（「按 2/4 维归一」这类硬文案） */
  note?: string;
}

export interface CompareRow {
  key: string;
  label: string;
  cells: CompareCell[];
}

/** OFF-9：截止与缺项提醒。文案在这里组装，组件只渲染 */
export interface OfferAlert {
  kind: 'deadline' | 'missing';
  appId: string;
  text: string;
  tone: 'warn' | 'muted';
}

const SCORE_LABEL: Record<OfferScoreKey, string> = {
  salary: '薪资',
  growth: '成长',
  city: '城市',
  wlb: 'WLB',
};

/** status ∈ {offer, onboarded}，已排除回收站（调用方传 viewDB 的结果） */
export function offerCandidatesOf(db: DB, now: Date): OfferCandidate[] {
  const weights = offerWeightsOf(db.settings);
  const noteIndex = buildNoteIndex(db.notes);
  const companyById = new Map(db.companies.map((company) => [company.id, company]));
  return db.applications
    .filter((app) => app.status === 'offer' || app.status === 'onboarded')
    .filter((app) => !app.deletedAt)
    .map((app) => ({
      app,
      company: companyById.get(app.companyId),
      offer: app.offer,
      score: computeOfferScore(app.offer?.scores, weights),
      deadline: deadlineStateOf(app, db.settings, now),
      silence: silenceStateOf(app, db.notes, db.settings, now, noteIndex),
    }))
    // 已入职的排在后面（回看场景：先看还在等答复的）
    .sort((a, b) => {
      const rankA = a.app.status === 'onboarded' ? 1 : 0;
      const rankB = b.app.status === 'onboarded' ? 1 : 0;
      return rankA - rankB;
    });
}

/** 默认全选；超过 8 个时按 offer.updatedAt 取最近 8 个（并返回被拒条数用于提示） */
export function defaultSelection(candidates: OfferCandidate[]): { ids: string[]; overflow: number } {
  if (candidates.length <= MAX_COMPARE) {
    return { ids: candidates.map((item) => item.app.id), overflow: 0 };
  }
  const sorted = [...candidates].sort((a, b) => {
    const at = a.offer?.updatedAt ?? '';
    const bt = b.offer?.updatedAt ?? '';
    return at < bt ? 1 : at > bt ? -1 : 0;
  });
  return {
    ids: sorted.slice(0, MAX_COMPARE).map((item) => item.app.id),
    overflow: candidates.length - MAX_COMPARE,
  };
}

/** 勾选第 9 个时的守卫：返回被接受的 id 与提示语 */
export function toggleSelection(ids: string[], next: string): { ids: string[]; rejected: boolean } {
  if (ids.includes(next)) return { ids: ids.filter((id) => id !== next), rejected: false };
  if (ids.length >= MAX_COMPARE) return { ids, rejected: true };
  return { ids: [...ids, next], rejected: false };
}

function salaryText(offer: OfferDetail | undefined): { text: string; tone?: CompareCell['tone'] } {
  if (!offer) return { text: '—', tone: 'muted' };
  if (offer.payMode === 'daily') {
    return offer.dailyRate
      ? { text: `${offer.dailyRate}/天` }
      : { text: '薪资未填', tone: 'muted' };
  }
  if (offer.monthlySalary && offer.salaryMonths) {
    return { text: `${Math.round(offer.monthlySalary / 100) / 10}k × ${offer.salaryMonths}` };
  }
  if (offer.monthlySalary) {
    return { text: `${Math.round(offer.monthlySalary / 100) / 10}k` };
  }
  return { text: '薪资未填', tone: 'muted' };
}

function wanText(value: number | undefined): string {
  if (!value) return '—';
  const wan = Math.round(value / 1000) / 10;
  return `${Number.isInteger(wan) ? wan : wan.toFixed(1)} 万`;
}

/** 并排对比表的行模型（列顺序 = selected 顺序） */
export function buildCompareRows(
  selected: OfferCandidate[],
  weights: Record<OfferScoreKey, number>,
): CompareRow[] {
  const rows: CompareRow[] = [];
  const scored = selected.map((item) => computeOfferScore(item.offer?.scores, weights));

  rows.push({
    key: 'total',
    label: '综合分',
    cells: scored.map((result) => ({
      text: result.total === null ? '—' : result.total.toFixed(1),
      tone: result.total === null ? 'muted' : 'primary',
      ...(result.normalized ? { note: `按 ${result.ratedCount}/4 维归一` } : {}),
    })),
  });

  for (const key of OFFER_SCORE_KEYS) {
    rows.push({
      key: `dim-${key}`,
      label: `${SCORE_LABEL[key]} ${weights[key]}`,
      cells: scored.map((result) => {
        const row = result.rows.find((item) => item.key === key);
        if (!row || !row.rated) return { text: '未评（不计入）', tone: 'muted' as const };
        return { text: `${row.score} ×${row.weight} = ${row.contribution.toFixed(1)}` };
      }),
    });
  }

  rows.push({
    key: 'salary',
    label: '薪资结构',
    cells: selected.map((item) => salaryText(item.offer)),
  });
  rows.push({
    key: 'signOn',
    label: '签字费',
    cells: selected.map((item) => {
      const bonus = item.offer?.signOnBonus;
      return bonus ? { text: wanText(bonus) } : { text: '—', tone: 'muted' as const };
    }),
  });
  rows.push({
    key: 'annual',
    label: '年薪合计',
    cells: selected.map((item) => {
      const text = annualTotalText(item.offer);
      return text.startsWith('不能算') || text === '薪资未填'
        ? { text, tone: 'muted' as const }
        : { text };
    }),
  });
  rows.push({
    key: 'equity',
    label: '股权',
    cells: selected.map((item) =>
      item.offer?.equityText
        ? { text: item.offer.equityText }
        : { text: '—', tone: 'muted' as const },
    ),
  });
  rows.push({
    key: 'cityLevel',
    label: '城市 / 职级',
    cells: selected.map((item) => ({
      text: `${item.app.city || '—'} · ${item.offer?.level || '—'}`,
    })),
  });
  rows.push({
    key: 'commute',
    label: '通勤',
    cells: selected.map((item) =>
      item.offer?.commuteMin === undefined
        ? { text: '—', tone: 'muted' as const }
        : { text: `${item.offer.commuteMin} 分钟` },
    ),
  });
  rows.push({
    key: 'deadline',
    label: '答复截止',
    cells: selected.map((item) => {
      if (!item.app.deadlineAt || item.deadline.days === null) {
        return { text: '—', tone: 'muted' as const };
      }
      const days = item.deadline.days;
      const tone: CompareCell['tone'] = days < 0 ? 'warn' : days <= 3 ? 'warn' : undefined;
      return { text: `${fmtDate(item.app.deadlineAt)}（${days} 天）`, ...(tone ? { tone } : {}) };
    }),
  });
  rows.push({
    key: 'rated',
    label: '已评维度',
    cells: scored.map((result) => ({
      text: `${result.ratedCount}/${OFFER_SCORE_KEYS.length}`,
      tone: result.ratedCount < OFFER_SCORE_KEYS.length ? ('warn' as const) : undefined,
      ...(result.normalized ? { note: '分数已归一' } : {}),
    })),
  });

  return rows;
}

/**
 * OFF-9：截止 ≤ deadlineWarnDays 的提醒 + 缺维提醒（P0 只做数据，文案在这里）。
 * 已入职的跳过两类提醒 —— 它已经不需要盯截止，也不缺决策了（Q4 / 待明确事项 5）。
 */
export function buildOfferAlerts(
  candidates: OfferCandidate[],
  settings: AppSettings,
  now: Date,
): OfferAlert[] {
  const alerts: OfferAlert[] = [];
  const warnDays = Math.max(1, settings.deadlineWarnDays);
  for (const item of candidates) {
    if (item.app.status === 'onboarded') continue;
    const label = item.company ? item.company.shortName || item.company.name : '这家公司';
    if (item.app.deadlineAt) {
      const days = daysBetween(now, item.app.deadlineAt);
      if (days <= warnDays) {
        const text =
          days < 0
            ? `${label} 已过答复截止 ${Math.abs(days)} 天`
            : days === 0
              ? `${label} 今天就要答复`
              : `${label} 还有 ${days} 天到期`;
        alerts.push({ kind: 'deadline', appId: item.app.id, text, tone: 'warn' });
      }
    }
    const missing = missingScoreCount(item.offer);
    if (missing > 0) {
      alerts.push({
        kind: 'missing',
        appId: item.app.id,
        text: `${label} 还有 ${missing} 维没评`,
        tone: 'muted',
      });
    }
  }
  return alerts;
}
