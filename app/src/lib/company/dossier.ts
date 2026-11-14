/**
 * 模块二 · 公司档案聚合（纯函数，零 React / 零 IO）。
 *
 * 用户点开公司档案的第一诉求是「这家还有没有戏」，所以结构顺序是
 * 概览 → 小计 → 投递 → 面试 → 面经 → 时间轴：**时间轴在最下面**（不是流水账优先）。
 *
 * 三条口径：
 * - 已删除的投递及其子记录一律不计入（`deletedAt` 由 App 的 `visibleDB` 摘过一次，
 *   这里再判一次是因为档案也可能被传入含回收站的库，宁可多判一次也不要「删了还看得见」）。
 * - 时间轴条目 = notes（含 `type:'system'`）+ interviews，按真实数据计（COM-1）。
 * - 面经按 `companyName` 字符串精确匹配，保证「档案里的 N」与「题库筛出来的 N」是同一个 N（COM-3）。
 */

import type { Application, Company, DB, Interview } from '../../types';
import {
  buildNoteIndex,
  NOTE_TYPE_LABEL,
  silenceStateOf,
  type SilenceState,
} from '../rules';
import { normalizeCompanyName } from '../sync/normalize';

export interface DossierTimelineEntry {
  id: string;
  /** ISO */
  at: string;
  who: 'me' | 'system';
  text: string;
  /** 岗位标签：「抖音前端」—— 三个岗位混在一起时这一列不能省 */
  jobLabel: string;
  kind: 'note' | 'interview';
}

export interface DossierApplicationRow {
  app: Application;
  silence: SilenceState;
  hasOffer: boolean;
}

export interface DossierInterviewRow {
  interview: Interview;
  appId: string;
  jobTitle: string;
}

export interface CompanyDossier {
  company: Company;
  applications: DossierApplicationRow[];
  interviews: DossierInterviewRow[];
  /** notes（含 type:'system'，按真实数据计）+ interviews，倒序（COM-1） */
  timeline: DossierTimelineEntry[];
  stats: {
    applications: number;
    interviewed: number;
    rejected: number;
    offer: number;
    avgSilenceDays: number;
  };
  /** COM-3：命中的面经原始 companyName 集合（跳题库用，保证两边同口径） */
  experienceNames: string[];
  experience: { total: number; unmastered: number };
}

function timeValue(value: string | undefined | null): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

/** 聚合一家公司的全部档案。公司不存在 → null（调用方不渲染抽屉） */
export function companyDossierOf(db: DB, companyId: string, now: Date): CompanyDossier | null {
  const company = db.companies.find((item) => item.id === companyId);
  if (!company) return null;

  const apps = db.applications.filter((app) => app.companyId === companyId && !app.deletedAt);
  const appById = new Map(apps.map((app) => [app.id, app]));
  const noteIndex = buildNoteIndex(db.notes);

  const applicationRows: DossierApplicationRow[] = apps.map((app) => ({
    app,
    silence: silenceStateOf(app, db.notes, db.settings, now, noteIndex),
    hasOffer: Boolean(app.offer),
  }));

  const interviewRows: DossierInterviewRow[] = db.interviews
    .filter((interview) => appById.has(interview.applicationId))
    .map((interview) => ({
      interview,
      appId: interview.applicationId,
      jobTitle: appById.get(interview.applicationId)?.jobTitle ?? '',
    }))
    .sort((a, b) => timeValue(b.interview.scheduledAt) - timeValue(a.interview.scheduledAt));

  const appIds = new Set(apps.map((app) => app.id));
  const timeline: DossierTimelineEntry[] = [];
  for (const note of db.notes) {
    if (!appIds.has(note.applicationId)) continue;
    timeline.push({
      id: note.id,
      at: note.touchedAt,
      who: note.auto ? 'system' : 'me',
      text: `${
        note.type === 'system' ? '' : `【${NOTE_TYPE_LABEL[note.type]}】`
      }${note.content}`,
      jobLabel: appById.get(note.applicationId)?.jobTitle ?? '',
      kind: 'note',
    });
  }
  for (const row of interviewRows) {
    const resultText =
      row.interview.result === 'passed'
        ? '已通过'
        : row.interview.result === 'failed'
          ? '已挂'
          : row.interview.result === 'cancelled'
            ? '已取消'
            : '待结果';
    timeline.push({
      id: row.interview.id,
      at: row.interview.scheduledAt,
      who: 'me',
      text: `第 ${row.interview.round} 轮面试 · ${resultText}`,
      jobLabel: row.jobTitle,
      kind: 'interview',
    });
  }
  timeline.sort((a, b) => timeValue(b.at) - timeValue(a.at));

  const silenceDays = applicationRows
    .filter((row) => row.silence.level !== null)
    .map((row) => row.silence.days);
  const avgSilenceDays =
    silenceDays.length === 0
      ? 0
      : Math.round((silenceDays.reduce((acc, days) => acc + days, 0) / silenceDays.length) * 10) / 10;

  const interviewed = apps.filter((app) =>
    interviewRows.some((row) => row.appId === app.id),
  ).length;

  const stats = {
    applications: apps.length,
    interviewed,
    rejected: apps.filter((app) => app.status === 'rejected').length,
    offer: apps.filter((app) => app.status === 'offer' || app.status === 'onboarded').length,
    avgSilenceDays,
  };

  // 面经匹配：公司名精确命中（含简称）**或** 面经挂在这家公司的某条投递上
  const names = new Set<string>([company.name.trim()]);
  if (company.shortName && company.shortName.trim()) names.add(company.shortName.trim());
  const matchedExperienceIds = new Set<string>();
  const experienceNames = new Set<string>();
  let questionTotal = 0;
  let questionUnmastered = 0;
  for (const experience of db.experiences) {
    const linked = experience.applicationId ? appIds.has(experience.applicationId) : false;
    const named = names.has((experience.companyName ?? '').trim());
    if (!linked && !named) continue;
    matchedExperienceIds.add(experience.id);
    experienceNames.add(experience.companyName);
    for (const question of db.questions) {
      if (question.experienceId !== experience.id) continue;
      questionTotal += 1;
      if (question.mastery === 0) questionUnmastered += 1;
    }
  }

  return {
    company,
    applications: applicationRows,
    interviews: interviewRows,
    timeline,
    stats,
    experienceNames: [...experienceNames],
    experience: { total: questionTotal, unmastered: questionUnmastered },
  };
}

/**
 * COM-6：归一化后同名的既有公司（排除自身）。
 * **只提示，不拦、不合并** —— 合并是破坏性操作，把判断权留给用户（PRD §6.2）。
 */
export function sameNameCompanies(db: DB, name: string, excludeId?: string): Company[] {
  const key = normalizeCompanyName(name);
  if (!key) return [];
  return db.companies.filter(
    (company) => company.id !== excludeId && normalizeCompanyName(company.name) === key,
  );
}
