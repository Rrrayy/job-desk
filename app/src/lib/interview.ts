/**
 * 面经纯函数层：排序 / 复习队列 / 间隔复习 / 统计。
 *
 * 两条间隔规则（架构 §8-歧义 12，分阶段，不引 SM-2/FSRS）：
 * - 初始（刚记完面经）：`interviewDate + 1/3/7`，取第一个 ≥ 今天的；都过了就 +7
 * - 复习后：mastery 0 → +3、1 → +7、2 → +14（**上限 14 天**，永不退化成每天刷题）
 */

import type {
  DB,
  Interview,
  InterviewExperience,
  Mastery,
  Question,
  QuestionCategory,
  RootCause,
} from '../types';
import { addDays, daysBetween, todayISO, toDateISO } from './date';

export const CATEGORY_LABEL: Record<QuestionCategory, string> = {
  algo: '算法',
  concept: '八股',
  project: '项目',
  behavior: '行为',
  reverse: '反问',
  hr: 'HR',
};

/** null = 没标（统计里单独一档「未分类」，不强行塞进 6 类） */
export const CATEGORY_NONE_LABEL = '未分类';

export const MASTERY_LABEL: Record<Mastery, string> = {
  0: '不会',
  1: '模糊',
  2: '会',
};

export const ROOT_CAUSE_LABEL: Record<RootCause, string> = {
  conceptGap: '概念没懂',
  forgot: '写过忘了',
  nervous: '紧张',
  misread: '没听懂题',
  neverSeen: '没见过',
};

/** 面经结果文案（注意：与 rules.ts 的 InterviewResult 文案不是一张表） */
export const EXPERIENCE_RESULT_LABEL: Record<InterviewExperience['result'], string> = {
  passed: '通过',
  failed: '未通过',
  pending: '还没消息',
  unknown: '不记得',
};

export const SOURCE_LABEL: Record<InterviewExperience['source'], string> = {
  self: '我自己记的',
  community: '社区面经',
};

export const CATEGORY_OPTIONS: QuestionCategory[] = ['algo', 'concept', 'project', 'behavior', 'reverse', 'hr'];
export const ROOT_CAUSE_OPTIONS: RootCause[] = ['conceptGap', 'forgot', 'nervous', 'misread', 'neverSeen'];

/** 某个 experience 下的题（按录入顺序） */
export function questionsOf(questions: Question[], experienceId: string): Question[] {
  return questions.filter((question) => question.experienceId === experienceId);
}

/** 某条投递下的面经（按面试日期倒序） */
export function experiencesOfApp(experiences: InterviewExperience[], applicationId: string): InterviewExperience[] {
  return experiences
    .filter((experience) => experience.applicationId === applicationId)
    .sort((a, b) => (a.interviewDate < b.interviewDate ? 1 : a.interviewDate > b.interviewDate ? -1 : 0));
}

/** 是否到期（含逾期） */
export function isDue(question: Question, today: string): boolean {
  if (!question.nextReviewAt) return false;
  return question.nextReviewAt <= today;
}

/**
 * 默认排序＝间隔复习轻量版：
 * mastery 0 最前 → 1 → 2；组内 nextReviewAt 升序（没设的排末尾）。
 */
export function sortQuestionsForReview(questions: Question[], now: string): Question[] {
  const today = toDateISO(new Date(now));
  return [...questions].sort((a, b) => {
    if (a.mastery !== b.mastery) return a.mastery - b.mastery;
    const aDue = isDue(a, today);
    const bDue = isDue(b, today);
    if (aDue !== bDue) return aDue ? -1 : 1;
    const aNext = a.nextReviewAt ?? '9999-12-31';
    const bNext = b.nextReviewAt ?? '9999-12-31';
    if (aNext !== bNext) return aNext < bNext ? -1 : 1;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
}

/** 复习队列：到期置顶（其余按默认排序跟在后面） */
export function reviewQueue(questions: Question[], now: string): Question[] {
  const today = toDateISO(new Date(now));
  const due = questions.filter((question) => isDue(question, today));
  const rest = questions.filter((question) => !isDue(question, today));
  return [...sortQuestionsForReview(due, now), ...sortQuestionsForReview(rest, now)];
}

/** 初始复习日：interviewDate + 1/3/7 里第一个 ≥ 今天的；都过了取 +7 */
export function deriveInitialNextReviewAt(interviewDate: string, now: string): string {
  const today = toDateISO(new Date(now));
  const base = new Date(interviewDate);
  if (Number.isNaN(base.getTime())) return today;
  for (const offset of [1, 3, 7]) {
    const candidate = toDateISO(addDays(base, offset));
    if (candidate >= today) return candidate;
  }
  return toDateISO(addDays(base, 7));
}

/** 复习一次之后的复习日：0 → +3、1 → +7、2 → +14（硬上限 14） */
export function nextReviewAtFor(masteryAfter: Mastery, today: string): string {
  const offsets: Record<Mastery, number> = { 0: 3, 1: 7, 2: 14 };
  const base = new Date(today);
  if (Number.isNaN(base.getTime())) return todayISO();
  return toDateISO(addDays(base, offsets[masteryAfter]));
}

/** 掌握度升一级（到 2 就停） */
export function bumpMastery(mastery: Mastery): Mastery {
  if (mastery >= 2) return 2;
  return (mastery + 1) as Mastery;
}

/** 距下次复习的天数；没设返回 null */
export function daysUntilReview(question: Question, now: string): number | null {
  if (!question.nextReviewAt) return null;
  return daysBetween(now, question.nextReviewAt);
}

/* ------------------------------- 统计 ------------------------------- */

export interface CategoryStat {
  category: QuestionCategory | null;
  label: string;
  /** 该分类下的题目数 */
  total: number;
  /** 挂掉的场次里，出现过该分类的场次数 */
  failedAppearances: number;
  /** failedAppearances / 挂掉的场次总数 */
  rate: number;
}

export function statsByCategory(db: DB): CategoryStat[] {
  const failedIds = new Set(
    db.experiences.filter((experience) => experience.result === 'failed').map((experience) => experience.id),
  );
  const failedTotal = failedIds.size;
  const buckets = new Map<string, { category: QuestionCategory | null; total: number; failed: Set<string> }>();

  for (const category of [...CATEGORY_OPTIONS, null] as Array<QuestionCategory | null>) {
    buckets.set(category ?? '__none__', { category, total: 0, failed: new Set() });
  }
  for (const question of db.questions) {
    const key = question.category ?? '__none__';
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.total += 1;
    if (failedIds.has(question.experienceId)) bucket.failed.add(question.experienceId);
  }

  return [...buckets.values()]
    .map((bucket) => ({
      category: bucket.category,
      label: bucket.category ? CATEGORY_LABEL[bucket.category] : CATEGORY_NONE_LABEL,
      total: bucket.total,
      failedAppearances: bucket.failed.size,
      rate: failedTotal > 0 ? bucket.failed.size / failedTotal : 0,
    }))
    .filter((stat) => stat.total > 0)
    .sort((a, b) => b.rate - a.rate || b.total - a.total);
}

export interface CompanyStat {
  companyName: string;
  /** 去重后的题干（同公司高频题） */
  items: { text: string; count: number; category: QuestionCategory | null }[];
  totalQuestions: number;
}

export function statsByCompany(db: DB): CompanyStat[] {
  const experienceById = new Map(db.experiences.map((experience) => [experience.id, experience]));
  const buckets = new Map<string, Map<string, { text: string; count: number; category: QuestionCategory | null }>>();

  for (const question of db.questions) {
    const experience = experienceById.get(question.experienceId);
    if (!experience) continue;
    const company = experience.companyName || '未知公司';
    if (!buckets.has(company)) buckets.set(company, new Map());
    const bucket = buckets.get(company);
    if (!bucket) continue;
    const key = question.text.trim().toLowerCase();
    const existing = bucket.get(key);
    if (existing) existing.count += 1;
    else bucket.set(key, { text: question.text.trim(), count: 1, category: question.category });
  }

  return [...buckets.entries()]
    .map(([companyName, items]) => {
      const list = [...items.values()].sort((a, b) => b.count - a.count);
      const totalQuestions = list.reduce((sum, item) => sum + item.count, 0);
      return { companyName, items: list, totalQuestions };
    })
    .sort((a, b) => b.totalQuestions - a.totalQuestions);
}

export interface RootCauseStat {
  rootCause: RootCause | null;
  label: string;
  count: number;
}

export function statsByRootCause(db: DB): RootCauseStat[] {
  const counts = new Map<string, number>();
  for (const question of db.questions) {
    const key = question.rootCause ?? '__none__';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const result: RootCauseStat[] = [];
  for (const rootCause of ROOT_CAUSE_OPTIONS) {
    const count = counts.get(rootCause) ?? 0;
    if (count > 0) result.push({ rootCause, label: ROOT_CAUSE_LABEL[rootCause], count });
  }
  const none = counts.get('__none__') ?? 0;
  if (none > 0) result.push({ rootCause: null, label: '没标原因', count: none });
  return result.sort((a, b) => b.count - a.count);
}

/** 掌握度分布（题库头部展示） */
export function masteryCounts(questions: Question[]): Record<Mastery, number> {
  const counts: Record<Mastery, number> = { 0: 0, 1: 0, 2: 0 };
  for (const question of questions) counts[question.mastery] += 1;
  return counts;
}

/* --------------------------- 待复盘（唯一数据源） --------------------------- */

export interface PendingReview {
  interview: Interview;
  applicationId: string;
  companyName: string;
  jobTitle?: string;
  round: number;
  interviewDate: string;
}

/**
 * 「N 场面试待复盘」的**唯一**数据源（TodayView 与 TodoBar 都必须用它，不许各算一遍）。
 *
 * 触发条件（架构 §8-歧义 15）：面试已过 且 result 已记（passed/failed）
 * 且**没有**对应的 InterviewExperience。cancelled 排除（取消的面试不需要复盘）。
 */
export function pendingReviewInterviews(db: DB, now: Date): PendingReview[] {
  const nowMs = now.getTime();
  const covered = new Set(
    db.experiences
      .filter((experience) => experience.applicationId)
      .map((experience) => `${experience.applicationId}#${experience.round ?? 0}`),
  );
  const result: PendingReview[] = [];
  for (const interview of db.interviews) {
    if (interview.result !== 'passed' && interview.result !== 'failed') continue;
    const at = new Date(interview.scheduledAt);
    if (Number.isNaN(at.getTime()) || at.getTime() > nowMs) continue;
    if (covered.has(`${interview.applicationId}#${interview.round}`)) continue;
    const app = db.applications.find((item) => item.id === interview.applicationId);
    if (!app) continue;
    const company = db.companies.find((item) => item.id === app.companyId);
    result.push({
      interview,
      applicationId: app.id,
      companyName: company ? company.shortName || company.name : '未知公司',
      jobTitle: app.jobTitle,
      round: interview.round,
      interviewDate: toDateISO(at),
    });
  }
  return result.sort((a, b) => (a.interview.scheduledAt < b.interview.scheduledAt ? 1 : -1));
}

/** 某场面试是否已经记过面经（详情抽屉的「记面经 / 已有 N 题」用） */
export function experienceForInterview(
  experiences: InterviewExperience[],
  applicationId: string,
  round: number,
): InterviewExperience | undefined {
  return experiences.find(
    (experience) => experience.applicationId === applicationId && (experience.round ?? 0) === round,
  );
}
