/**
 * 模块一 · 决策的读写 recipe 与回看视图（纯函数，零 React / 零 IO）。
 *
 * 三条硬约束：
 * 1. `applyDecision` **只改 `draft.offerDecision`** —— 不碰任何 Application 字段（OFF-8）。
 *    记录选择 ≠ 已经拒了别人；自动改状态会在用户还没通知 HR 时就把管线画成完成态。
 * 2. `applyOfferPatch` **不写 note、不动 lastActivityAt** —— 改了薪资不该让沉默天数归零。
 * 3. 回看只输出**绝对日期**（OFF-7）：调系统时间到决策日 +180 天后仍显示同一天，
 *    所以这里绝不调用 `relativeCountdown`。
 */

import type { Application, DB, OfferDecision, OfferDetail } from '../../types';
import type { OfferPatch, SaveDecisionInput } from '../api';
import type { CompareRow } from './compare';
import { OFFER_SCORE_KEYS } from './score';

/** 内置理由标签（8 个）。`key` 与 `OfferScoreKey` 前四个同名，便于将来做「理由 → 权重」的提示 */
export const REASON_TAG_PRESETS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'pay', label: '薪资' },
  { key: 'growth', label: '成长' },
  { key: 'city', label: '城市' },
  { key: 'wlb', label: 'WLB' },
  { key: 'team', label: '团队' },
  { key: 'brand', label: '品牌' },
  { key: 'conversion', label: '转正' },
  { key: 'deadline', label: '截止' },
];

/** 一段话上限（PRD §4.2） */
export const DECISION_NOTE_LIMIT = 500;
/** 理由标签个数上限 */
export const DECISION_TAG_LIMIT = 5;
/** 单个理由标签字数上限（超长截断而不是丢弃 —— §D.4「不静默丢」） */
export const DECISION_TAG_CHAR_LIMIT = 10;

/** 被放弃的一条（回看用）。`alive=false` 表示这条投递已经不在库里了 */
export interface DeclinedRef {
  id: string;
  label: string;
  alive: boolean;
}

export interface DecisionView {
  decision: OfferDecision;
  app: Application | null;
  /** 悬空 → '（投递已删除）' */
  companyLabel: string;
  jobTitle: string;
  /** ★ 绝对日期 YYYY-MM-DD，**绝不出相对文案**（OFF-7 验收） */
  decidedAtText: string;
  /** 理由标签拼成一行 */
  reasonText: string;
  /** note 的前 3 行（回看卡只露这些） */
  firstLines: string;
  declined: DeclinedRef[];
}

/** ≤5 个、去空、去重、每个 ≤10 字（超长截断而不是丢弃） */
export function sanitizeReasonTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const text = item.trim().slice(0, DECISION_TAG_CHAR_LIMIT);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    tags.push(text);
    if (tags.length >= DECISION_TAG_LIMIT) break;
  }
  return tags;
}

function cleanDeclinedIds(raw: unknown, applicationId: string): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || id === applicationId || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * ★ 纯写库 recipe：只改 `draft.offerDecision`，**不碰 applications 任何字段**（OFF-8 的断言）。
 *
 * 覆盖式写入（改选即覆盖，二次确认由组件层负责 —— D-05：App 层只信「调用方已确认」）。
 */
export function applyDecision(draft: DB, input: SaveDecisionInput): void {
  const decision: OfferDecision = {
    applicationId: input.applicationId,
    decidedAt: input.decidedAt,
    reasonTags: sanitizeReasonTags(input.reasonTags),
  };
  const note = (input.note ?? '').trim().slice(0, DECISION_NOTE_LIMIT);
  if (note) decision.note = note;
  const declined = cleanDeclinedIds(input.declinedIds, input.applicationId);
  if (declined.length > 0) decision.declinedIds = declined;
  draft.offerDecision = decision;
}

/** 一次性写入的字段（`null` / `undefined` = 清空该字段，写库时删键而不是写空串） */
const OFFER_NUMBER_FIELDS = ['monthlySalary', 'salaryMonths', 'dailyRate', 'signOnBonus', 'commuteMin'] as const;
const OFFER_TEXT_FIELDS = ['equityText', 'level', 'notes'] as const;

/**
 * ★ 纯写库 recipe：只改 `target.offer`，不碰 lastActivityAt、不写 note。
 *
 * 返回 false = 投递不存在（调用方静默返回，不 toast —— 沿用 bindResumeVersion 的风格）。
 */
export function applyOfferPatch(draft: DB, appId: string, patch: OfferPatch, nowIso: string): boolean {
  const target = draft.applications.find((app) => app.id === appId);
  if (!target) return false;

  const next: OfferDetail = { ...(target.offer ?? { updatedAt: nowIso }) };

  for (const field of OFFER_NUMBER_FIELDS) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (value === null || value === undefined) delete next[field];
    else next[field] = value;
  }
  for (const field of OFFER_TEXT_FIELDS) {
    if (!(field in patch)) continue;
    const value = patch[field];
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) delete next[field];
    else next[field] = text;
  }
  if ('payMode' in patch) {
    if (patch.payMode === 'monthly' || patch.payMode === 'daily') next.payMode = patch.payMode;
    else delete next.payMode;
  }
  if ('scores' in patch) {
    const raw = patch.scores;
    if (raw === null || raw === undefined) {
      delete next.scores;
    } else {
      const scores: NonNullable<OfferDetail['scores']> = {};
      for (const key of OFFER_SCORE_KEYS) {
        const value = raw[key];
        if (value === 1 || value === 2 || value === 3 || value === 4 || value === 5) scores[key] = value;
      }
      if (Object.keys(scores).length > 0) next.scores = scores;
      else delete next.scores;
    }
  }

  // 只剩 updatedAt = 什么都没填 → 整个区块消失（OFF-1：九字段全空时折叠成一行）
  const hasContent = Object.keys(next).some((key) => key !== 'updatedAt');
  if (!hasContent) {
    delete target.offer;
    return true;
  }
  next.updatedAt = nowIso;
  target.offer = next;
  return true;
}

/** 悬空标签：决策指向的投递被删了，仍然要能读，且明确说「已删除」 */
export const DELETED_DECISION_LABEL = '（投递已删除）';

function labelOfApp(db: DB, app: Application): string {
  const company = db.companies.find((item) => item.id === app.companyId);
  const name = company ? company.shortName || company.name : '未知公司';
  return `${name} · ${app.jobTitle}`;
}

/** 决策视图：悬空时 companyLabel = '（投递已删除）'；没决策 = null */
export function decisionViewOf(db: DB, decision: OfferDecision | undefined): DecisionView | null {
  if (!decision) return null;
  const app = db.applications.find((item) => item.id === decision.applicationId) ?? null;
  const note = decision.note ?? '';
  return {
    decision,
    app,
    companyLabel: app ? labelOfApp(db, app).split(' · ')[0] : DELETED_DECISION_LABEL,
    jobTitle: app ? app.jobTitle : '',
    decidedAtText: decision.decidedAt,
    reasonText: decision.reasonTags.join(' · '),
    firstLines: note
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join('\n'),
    declined: (decision.declinedIds ?? []).map((id) => {
      const found = db.applications.find((item) => item.id === id);
      return {
        id,
        label: found ? labelOfApp(db, found) : '（这条投递已删除）',
        alive: Boolean(found),
      };
    }),
  };
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * OFF-10（P1）：决策导出为一段 Markdown（对比表 + 权重 + 选择与理由）。
 * 末行固定「本地加权计算，仅供参考」—— 这句防止用户把工具当算命。
 */
export function decisionToMarkdown(input: {
  view: DecisionView;
  rows: CompareRow[];
  weights: Record<string, number>;
}): string {
  const { view, rows, weights } = input;
  const lines: string[] = [];
  lines.push(`# 我的 Offer 选择（${view.decidedAtText}）`, '');
  lines.push(`- 我选了：${view.companyLabel}${view.jobTitle ? ` · ${view.jobTitle}` : ''}`);
  lines.push(`- 决策日：${view.decidedAtText}`);
  if (view.reasonText) lines.push(`- 为什么：${view.reasonText}`);
  if (view.declined.length > 0) {
    lines.push(`- 我放弃了：${view.declined.map((item) => item.label).join('；')}`);
  }
  const weightText = OFFER_SCORE_KEYS.map((key) => `${key} ${weights[key] ?? 0}`).join(' / ');
  lines.push(`- 权重：${weightText}`);
  lines.push('');
  if (view.firstLines) {
    lines.push(view.firstLines, '');
  }
  if (rows.length > 0) {
    const header = ['项目', ...rows[0].cells.map((_, index) => `Offer ${index + 1}`)];
    lines.push(`| ${header.join(' | ')} |`);
    lines.push(`| ${header.map(() => '---').join(' | ')} |`);
    for (const row of rows) {
      const cells = row.cells.map((cell) =>
        escapeCell(cell.note ? `${cell.text}（${cell.note}）` : cell.text),
      );
      lines.push(`| ${[row.label, ...cells].join(' | ')} |`);
    }
    lines.push('');
  }
  lines.push('> 本地加权计算，仅供参考。');
  return lines.join('\n');
}
