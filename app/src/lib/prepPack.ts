/**
 * U1 面试备战包（纯函数层）：**派生视图，不落库**。
 *
 * 打开一场**未开始**的面试时，按固定优先级排出一批「建议带进去」的题：
 *
 *   1. 上一场同类挂的题 —— 题带 `rootCause`（我知道自己为什么挂），且按 `category`
 *      聚成「同类」。有「这类会问、而且我挂过」的具体证据，排最前。
 *   2. 这家公司以前问过的题 —— `statsByCompany` 里同名的那些题。
 *   3. 题库到期 —— `reviewQueue()` 里 due 的题。
 *
 * ★ 优先级顺序是产品定案的，不要调换：前两条有「这家/这类会问」的证据，
 *   第三条只是「时间到了」。**到期题仍全部列出来，只是排在最后** ——
 *   所以这里刻意**不做条数上限**（截断属于 UI 决策，不属于派生口径）。
 *
 * 三条纪律（改这个文件前先读）：
 *
 * - **不落库、不加字段。** 这里产出的是内存对象，唯一写库的路径是
 *   `withSuggestedPrepItem` 生成的一条**普通** `prepChecklist` 项，形状严格是
 *   `{ id, text, done: false }`。「来源」只在渲染时算，**绝不能写进库**：
 *   `validateV2 → validateV1` 的 prepChecklist 白名单（`validateV1.ts` 里
 *   `{ id, text, done }` 三个字段）**每次启动都在跑**，多存一个字段就是
 *   「当场好、刷新坏」—— 比迁移丢数据难查十倍。
 * - **id 用 `uid('p')`，不许用下标。** `validateV1` 对缺失 id 的回落是
 *   `p_${index}`，下标式 id 在删掉中间一项后会重排、勾选状态跟着串位。
 * - **题干写入前过 `clampText`。** `validateV1` 对 `text` 没有长度上限，
 *   校验器不会帮你截；`clampText` 返回 `truncated` 时必须 toast，不能静默截断。
 *
 * 作用域：**单场**。只有「打开一场面试」时才调用它。不要接进今日视图 / 日历 /
 * TodoBar 的批量派生 —— 那些是 O(n²) 链（每场面试都要扫一遍全库题目）。
 */

import type { DB, Interview, InterviewExperience, QuestionCategory, RootCause } from '../types';
import { clampText } from './budget';
import { toDateISO } from './date';
import {
  CATEGORY_LABEL,
  CATEGORY_NONE_LABEL,
  CATEGORY_OPTIONS,
  QUESTION_TEXT_LIMIT,
  ROOT_CAUSE_LABEL,
  isDue,
  reviewQueue,
  statsByCompany,
} from './interview';

/** 准备清单一项的形状（与 `validateV1` 白名单逐字段一致，多一个都不行） */
export type PrepChecklistItem = NonNullable<Interview['prepChecklist']>[number];

/** 建议的来源档位，同时也是排序档位（数值即优先级） */
export type PrepSourceKind = 'rootCause' | 'company' | 'due';

export interface PrepSuggestion {
  /** React key / 去重用的稳定标识（`kind:归一化题干`，不写库） */
  key: string;
  text: string;
  /** 来源标签，**只用于渲染** */
  source: string;
  kind: PrepSourceKind;
  category: QuestionCategory | null;
}

/** 题干归一化：去首尾空白 + 小写。去重与「已在清单里」判定共用这一个口径 */
function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function categoryKeyOf(category: QuestionCategory | null): string {
  return category ?? '__none__';
}

function categoryLabelOf(category: QuestionCategory | null): string {
  return category ? CATEGORY_LABEL[category] : CATEGORY_NONE_LABEL;
}

function categoryOrderOf(category: QuestionCategory | null): number {
  // 未分类殿后：它没有「同类」可言，排在 6 个真分类之后
  return category ? CATEGORY_OPTIONS.indexOf(category) : CATEGORY_OPTIONS.length;
}

/**
 * 这场面试是否「未开始」：时间还没到，且结果仍是 pending。
 * 已取消（`cancelled`）不备战 —— 取消的面试不用带东西进去。
 *
 * UI 与测试**必须共用这一个判定**，否则「面板出现条件」会在两处慢慢分叉。
 */
export function isUpcomingInterview(interview: Interview, now: Date): boolean {
  if (interview.result !== 'pending') return false;
  const at = new Date(interview.scheduledAt);
  if (Number.isNaN(at.getTime())) return false;
  return at.getTime() > now.getTime();
}

interface RootCauseRow {
  text: string;
  category: QuestionCategory | null;
  rootCause: RootCause;
  interviewDate: string;
  mastery: number;
}

/**
 * 第 1 档：挂掉的面经里、带 `rootCause` 的题，按「同类」聚合排序。
 *
 * 排序（从强到弱）：该 `category` 在挂掉的题里出现的次数（降序）→
 * 分类固定顺序（未分类殿后）→ 面经日期（最近挂的在前）→ 掌握度（越不会越前）→ 题干。
 * 一次挂科就算一次「这类会问」的证据，同类挂得越多证据越硬。
 */
function rootCauseRows(db: DB): RootCauseRow[] {
  const failed = new Map<string, InterviewExperience>();
  for (const experience of db.experiences) {
    if (experience.result === 'failed') failed.set(experience.id, experience);
  }
  if (failed.size === 0) return [];

  const rows: RootCauseRow[] = [];
  const perCategory = new Map<string, number>();
  for (const question of db.questions) {
    const experience = failed.get(question.experienceId);
    if (!experience) continue;
    // 没写 rootCause = 不知道该补什么，不该冒充「我知道自己挂在哪」
    if (!question.rootCause) continue;
    const key = categoryKeyOf(question.category);
    perCategory.set(key, (perCategory.get(key) ?? 0) + 1);
    rows.push({
      text: question.text,
      category: question.category,
      rootCause: question.rootCause,
      interviewDate: experience.interviewDate,
      mastery: question.mastery,
    });
  }

  return rows.sort((a, b) => {
    const countDiff =
      (perCategory.get(categoryKeyOf(b.category)) ?? 0) - (perCategory.get(categoryKeyOf(a.category)) ?? 0);
    if (countDiff !== 0) return countDiff;
    const orderDiff = categoryOrderOf(a.category) - categoryOrderOf(b.category);
    if (orderDiff !== 0) return orderDiff;
    if (a.interviewDate !== b.interviewDate) return a.interviewDate < b.interviewDate ? 1 : -1;
    if (a.mastery !== b.mastery) return a.mastery - b.mastery;
    return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
  });
}

/**
 * 第 2 档：这家公司以前问过的题（`statsByCompany` 的同一份数据，不另算一遍）。
 *
 * 公司名匹配用 `name` 与 `shortName` 两个都试：面经里的 `companyName` 是用户录入的，
 * 有人写全名有人写简称，两边都要认。
 */
function companyQuestions(
  db: DB,
  interview: Interview,
): { text: string; count: number; category: QuestionCategory | null }[] {
  const app = db.applications.find((item) => item.id === interview.applicationId);
  if (!app) return [];
  const company = db.companies.find((item) => item.id === app.companyId);
  if (!company) return [];
  const names = new Set(
    [company.name, company.shortName ?? ''].map(normalizeText).filter((name) => name !== ''),
  );
  const stat = statsByCompany(db).find((entry) => names.has(normalizeText(entry.companyName)));
  return stat ? stat.items : [];
}

/**
 * 派生一整份备战包（纯函数，不碰 db）。
 *
 * 已经在准备清单里的题不会重复建议 —— `taken` 同时承担「跨档去重」：
 * 一道题既属于「同类挂过」又刚好到期，只在第 1 档出现一次。
 */
export function buildPrepPack(params: { db: DB; interview: Interview; now: Date }): PrepSuggestion[] {
  const { db, interview, now } = params;
  const taken = new Set<string>();
  for (const item of interview.prepChecklist ?? []) {
    const key = normalizeText(item.text);
    if (key) taken.add(key);
  }

  const pack: PrepSuggestion[] = [];
  const push = (text: string, source: string, kind: PrepSourceKind, category: QuestionCategory | null): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const key = normalizeText(trimmed);
    if (taken.has(key)) return;
    taken.add(key);
    pack.push({ key: `${kind}:${key}`, text: trimmed, source, kind, category });
  };

  // 1) 上一场同类挂的题
  for (const row of rootCauseRows(db)) {
    push(
      row.text,
      `上次挂在「${categoryLabelOf(row.category)}」·${ROOT_CAUSE_LABEL[row.rootCause]}`,
      'rootCause',
      row.category,
    );
  }

  // 2) 这家公司以前问过的题
  for (const item of companyQuestions(db, interview)) {
    push(item.text, `这家问过 ${item.count} 次`, 'company', item.category);
  }

  // 3) 题库到期（全部列出，只是排在最后）
  const today = toDateISO(now);
  for (const question of reviewQueue(db.questions, now.toISOString())) {
    if (!isDue(question, today)) continue;
    push(question.text, `复习到期 · ${question.nextReviewAt ?? today}`, 'due', question.category);
  }

  return pack;
}

/**
 * 把一条建议并进准备清单（纯函数）：**唯一**的「点按钮 → 可落库对象」的入口。
 *
 * - 题干 trim + `clampText` 截断（上限与题库同一个 2000）；
 * - 已在清单里（归一化题干相同）就不再加，返回 `added: false` 让 UI 去说话；
 * - 产出的行**只有** `id / text / done` 三个字段，`done` 恒为 `false`
 *   —— 备战时没人做过这件事，替用户勾上就是伪造事实；
 * - `makeId` 注入以便单测确定化；生产传 `uid`（前缀 `p`，**不是下标**）。
 */
export function withSuggestedPrepItem(
  checklist: PrepChecklistItem[],
  text: string,
  makeId: (prefix: string) => string,
): { next: PrepChecklistItem[]; added: boolean; truncated: boolean } {
  const { text: clamped, truncated } = clampText(text.trim(), QUESTION_TEXT_LIMIT);
  if (!clamped) return { next: checklist, added: false, truncated };
  const key = normalizeText(clamped);
  if (checklist.some((item) => normalizeText(item.text) === key)) {
    return { next: checklist, added: false, truncated };
  }
  return {
    next: [...checklist, { id: makeId('p'), text: clamped, done: false }],
    added: true,
    truncated,
  };
}
