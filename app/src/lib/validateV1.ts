/**
 * v1 结构归一化（从 storage.ts 搬运），并抽出 v1/v2 共用的「核心四表」归一化。
 *
 * 与 v0.1 的唯一区别（架构 D-06）：**所有 `new Date()` 换成 `ctx.nowIso`**。
 * 为什么必须这样：迁移契约要求「不读时间、幂等」。若校验器内部补 `new Date()`，
 * 同一份数据迁移两次就得到两个不同的结果，「无损」这条验收无法自动化。
 */

import type { Application, Channel, Company, Interview, Note, PlatformId, Status } from '../types';
import { ALL_STATUSES } from './rules';

/** v0.1 的 settings 形状（没有 sync / lastMigration，schemaVersion 固定 1） */
export interface V1Settings {
  schemaVersion: 1;
  warnAfterDays: number;
  staleAfterDays: number;
  interviewResultWaitDays: number;
  wishlistExpireDays: number;
  resultPromptHour: number;
  channelFactor: Record<Channel, number>;
  weeklyApplyGoal: number;
  courseSlots: { weekday: number; start: string; end: string; name: string }[];
  defaultResumeVersion?: string;
}

export interface V1Data {
  settings: V1Settings;
  companies: Company[];
  applications: Application[];
  interviews: Interview[];
  notes: Note[];
}

export type V1Result = { ok: true; data: V1Data } | { ok: false; error: string };

export interface CoreArrays {
  companies: Company[];
  applications: Application[];
  interviews: Interview[];
  notes: Note[];
}

/** v1 的默认设置（与 v0.1 storage.defaultSettings 逐字段一致） */
export const V1_DEFAULTS: V1Settings = {
  schemaVersion: 1,
  warnAfterDays: 3,
  staleAfterDays: 7,
  interviewResultWaitDays: 5,
  wishlistExpireDays: 7,
  resultPromptHour: 20,
  channelFactor: {
    referral: 3,
    official: 2,
    boss: 1,
    shixiseng: 1,
    nowcoder: 1,
    liepin: 1,
    other: 1,
  },
  weeklyApplyGoal: 8,
  courseSlots: [],
  defaultResumeVersion: '',
};

/** v1 允许的 note 类型（v2 多一个 'sync'） */
export const V1_NOTE_TYPES = ['chat', 'interview', 'followup', 'system', 'memo'];
export const V2_NOTE_TYPES = [...V1_NOTE_TYPES, 'sync'];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 纯日期（YYYY-MM-DD）或 ISO 8601 时间戳 —— 只做形状判定，不做日历合法性判定 */
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.+\-Zz]+)?$/;

/**
 * 三态日期字段归一化（deadlineAt / mutedUntil 专用）。
 *
 * ★ 绝不能写成 `asOptionalString(v) || null`：
 *   undefined（没这个字段 = 跟随上层）与 null（显式关闭 = 上层有也不跟）
 *   是两条相反的业务路径，一旦折成一支，历史数据里「没设置」的投递会被
 *   读成「用户主动关闭了截止提醒」，此后再也不会提醒。
 * 脏数据（非字符串 / 空串 / 形状不对）一律回 undefined —— 宁可变回「跟随」，
 * 也不要凭一条错值把提醒永久关掉。
 */
export function asTriStateDate(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return DATE_LIKE.test(text) ? text : undefined;
}

/**
 * 核心四表（公司/投递/面试/时间线）的字段级归一化 —— v1 与 v2 共用同一份实现。
 * 唯一的差异是 `noteTypes`（v2 多 'sync'），这样「v1 备份导入」与「v2 备份导入」
 * 对同一条记录的字段处理**永远不会漂移**。
 */
export function normalizeCoreArrays(
  raw: Record<string, unknown>,
  nowIso: string,
  noteTypes: string[],
): { ok: true; data: CoreArrays } | { ok: false; error: string } {
  const arrays: Array<'companies' | 'applications' | 'interviews' | 'notes'> = [
    'companies',
    'applications',
    'interviews',
    'notes',
  ];
  for (const key of arrays) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) return { ok: false, error: `字段 ${key} 必须是数组` };
  }

  const rawCompanies = Array.isArray(raw.companies) ? raw.companies : [];
  const rawApplications = Array.isArray(raw.applications) ? raw.applications : [];
  const rawInterviews = Array.isArray(raw.interviews) ? raw.interviews : [];
  const rawNotes = Array.isArray(raw.notes) ? raw.notes : [];

  const companies: Company[] = [];
  for (let i = 0; i < rawCompanies.length; i += 1) {
    const item = rawCompanies[i];
    if (!isRecord(item)) return { ok: false, error: `第 ${i + 1} 个公司不是对象` };
    const id = asString(item.id);
    const name = asString(item.name);
    if (!id) return { ok: false, error: `第 ${i + 1} 个公司缺少 id` };
    if (!name) return { ok: false, error: `第 ${i + 1} 个公司缺少 name` };
    companies.push({
      id,
      name,
      shortName: asOptionalString(item.shortName),
      industry: asOptionalString(item.industry),
      city: asOptionalString(item.city),
      referrer: asOptionalString(item.referrer),
      impression: asOptionalString(item.impression),
      createdAt: asString(item.createdAt) || nowIso,
    });
  }

  const applications: Application[] = [];
  for (let i = 0; i < rawApplications.length; i += 1) {
    const item = rawApplications[i];
    if (!isRecord(item)) return { ok: false, error: `第 ${i + 1} 条投递不是对象` };
    const id = asString(item.id);
    const companyId = asString(item.companyId);
    const jobTitle = asString(item.jobTitle);
    const status = asString(item.status) as Status;
    if (!id) return { ok: false, error: `第 ${i + 1} 条投递缺少 id` };
    if (!companyId) return { ok: false, error: `第 ${i + 1} 条投递缺少 companyId` };
    if (!jobTitle) return { ok: false, error: `第 ${i + 1} 条投递缺少 jobTitle` };
    if (!ALL_STATUSES.includes(status)) {
      return { ok: false, error: `第 ${i + 1} 条投递的 status「${asString(item.status)}」不合法` };
    }
    const app: Application = {
      id,
      companyId,
      jobTitle,
      jobType:
        item.jobType === 'summer' || item.jobType === 'fulltime' || item.jobType === 'daily'
          ? item.jobType
          : 'daily',
      city: asOptionalString(item.city),
      channel: asOptionalString(item.channel) as Channel | undefined,
      appliedAt: asOptionalString(item.appliedAt),
      status,
      statusChangedAt: asString(item.statusChangedAt) || nowIso,
      lastActivityAt: asString(item.lastActivityAt) || asString(item.statusChangedAt) || nowIso,
      jdUrl: asOptionalString(item.jdUrl),
      resumeVersion: asOptionalString(item.resumeVersion),
      salaryText: asOptionalString(item.salaryText),
      daysPerWeek: typeof item.daysPerWeek === 'number' ? item.daysPerWeek : undefined,
      durationMonths: typeof item.durationMonths === 'number' ? item.durationMonths : undefined,
      silenceOverride: typeof item.silenceOverride === 'number' ? item.silenceOverride : null,
      rejectedAtRound: typeof item.rejectedAtRound === 'number' ? item.rejectedAtRound : null,
      rejectReason: asOptionalString(item.rejectReason),
      nextActionAt: asOptionalString(item.nextActionAt) || null,
      // v0.3 三态字段：必须原样保留 undefined / null 的区别，理由见 asTriStateDate
      deadlineAt: asTriStateDate(item.deadlineAt),
      mutedUntil: asTriStateDate(item.mutedUntil),
      priority:
        item.priority === 1 || item.priority === 2 || item.priority === 3 ? item.priority : undefined,
      tags: Array.isArray(item.tags)
        ? item.tags.filter((tag): tag is string => typeof tag === 'string')
        : [],
      createdAt: asString(item.createdAt) || nowIso,
      updatedAt: asString(item.updatedAt) || nowIso,
    };
    // v2 可选字段：老备份没有就保持 undefined（不补空对象，避免污染 diff）
    if (isRecord(item.sync)) {
      const syncRaw = item.sync;
      app.sync = {
        platform: asString(syncRaw.platform) as PlatformId,
        externalId: asOptionalString(syncRaw.externalId),
        matchKey: asOptionalString(syncRaw.matchKey),
        matchKeyVersion:
          typeof syncRaw.matchKeyVersion === 'number' ? syncRaw.matchKeyVersion : undefined,
        platformStatusRaw: asOptionalString(syncRaw.platformStatusRaw),
        lastContactAt: asOptionalString(syncRaw.lastContactAt),
        lastSyncedAt: asOptionalString(syncRaw.lastSyncedAt),
      };
    }
    if (isRecord(item.userEditedAt)) {
      app.userEditedAt = item.userEditedAt as Application['userEditedAt'];
    }
    applications.push(app);
  }

  const interviews: Interview[] = [];
  for (let i = 0; i < rawInterviews.length; i += 1) {
    const item = rawInterviews[i];
    if (!isRecord(item)) return { ok: false, error: `第 ${i + 1} 场面试不是对象` };
    const id = asString(item.id);
    const applicationId = asString(item.applicationId);
    const scheduledAt = asString(item.scheduledAt);
    const format = asString(item.format);
    const result = asString(item.result);
    if (!id) return { ok: false, error: `第 ${i + 1} 场面试缺少 id` };
    if (!applicationId) return { ok: false, error: `第 ${i + 1} 场面试缺少 applicationId` };
    if (!scheduledAt) return { ok: false, error: `第 ${i + 1} 场面试缺少 scheduledAt` };
    if (format !== 'onsite' && format !== 'video' && format !== 'phone') {
      return { ok: false, error: `第 ${i + 1} 场面试的 format 不合法` };
    }
    if (result !== 'pending' && result !== 'passed' && result !== 'failed' && result !== 'cancelled') {
      return { ok: false, error: `第 ${i + 1} 场面试的 result 不合法` };
    }
    const checklist = Array.isArray(item.prepChecklist)
      ? item.prepChecklist.filter(isRecord).map((point, index) => ({
          id: asString(point.id) || `p_${index}`,
          text: asString(point.text),
          done: point.done === true,
        }))
      : [];
    interviews.push({
      id,
      applicationId,
      round: typeof item.round === 'number' && item.round > 0 ? item.round : 1,
      totalRounds: typeof item.totalRounds === 'number' ? item.totalRounds : null,
      scheduledAt,
      durationMin: typeof item.durationMin === 'number' ? item.durationMin : undefined,
      format,
      locationOrLink: asOptionalString(item.locationOrLink),
      interviewer: asOptionalString(item.interviewer),
      prepChecklist: checklist,
      result,
      notes: asOptionalString(item.notes),
    });
  }

  const notes: Note[] = [];
  for (let i = 0; i < rawNotes.length; i += 1) {
    const item = rawNotes[i];
    if (!isRecord(item)) return { ok: false, error: `第 ${i + 1} 条时间线不是对象` };
    const id = asString(item.id);
    const applicationId = asString(item.applicationId);
    const touchedAt = asString(item.touchedAt);
    const type = asString(item.type);
    if (!id) return { ok: false, error: `第 ${i + 1} 条时间线缺少 id` };
    if (!applicationId) return { ok: false, error: `第 ${i + 1} 条时间线缺少 applicationId` };
    if (!touchedAt) return { ok: false, error: `第 ${i + 1} 条时间线缺少 touchedAt` };
    if (!noteTypes.includes(type)) {
      return { ok: false, error: `第 ${i + 1} 条时间线的 type 不合法` };
    }
    const note: Note = {
      id,
      applicationId,
      type: type as Note['type'],
      content: asString(item.content),
      auto: item.auto === true,
      touchedAt,
    };
    if (isRecord(item.source)) {
      const sourceRaw = item.source;
      note.source = {
        platform: asString(sourceRaw.platform) as NonNullable<Note['source']>['platform'],
        externalId: asOptionalString(sourceRaw.externalId),
        capturedAt: asString(sourceRaw.capturedAt) || touchedAt,
        platformTime: asOptionalString(sourceRaw.platformTime),
      };
    }
    notes.push(note);
  }

  // 引用了不存在的公司/投递，会让界面出现「未知公司」，直接拦下来
  const companyIds = new Set(companies.map((company) => company.id));
  for (const app of applications) {
    if (!companyIds.has(app.companyId)) {
      return { ok: false, error: `投递「${app.jobTitle}」引用了不存在的公司（${app.companyId}）` };
    }
  }
  const appIds = new Set(applications.map((app) => app.id));
  for (const interview of interviews) {
    if (!appIds.has(interview.applicationId)) {
      return { ok: false, error: `面试记录（第 ${interview.round} 轮）引用了不存在的投递` };
    }
  }
  for (const note of notes) {
    if (!appIds.has(note.applicationId)) {
      return { ok: false, error: '时间线条目引用了不存在的投递' };
    }
  }

  return { ok: true, data: { companies, applications, interviews, notes } };
}

/** v1 settings 归一化（允许缺字段，缺了用默认值；**不读时间**） */
export function normalizeV1Settings(rawSettings: Record<string, unknown>): V1Settings {
  const channelFactor = { ...V1_DEFAULTS.channelFactor };
  if (isRecord(rawSettings.channelFactor)) {
    for (const key of Object.keys(channelFactor) as Channel[]) {
      const value = rawSettings.channelFactor[key];
      if (typeof value === 'number' && value > 0) channelFactor[key] = value;
    }
  }

  const courseSlots = Array.isArray(rawSettings.courseSlots)
    ? rawSettings.courseSlots.filter(isRecord).map((slot) => ({
        weekday:
          typeof slot.weekday === 'number' && slot.weekday >= 1 && slot.weekday <= 7 ? slot.weekday : 1,
        start: asString(slot.start) || '00:00',
        end: asString(slot.end) || '00:00',
        name: asString(slot.name),
      }))
    : [];

  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  const hour = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(23, Math.max(0, Math.round(value)))
      : fallback;

  return {
    schemaVersion: 1,
    warnAfterDays: num(rawSettings.warnAfterDays, V1_DEFAULTS.warnAfterDays),
    staleAfterDays: num(rawSettings.staleAfterDays, V1_DEFAULTS.staleAfterDays),
    interviewResultWaitDays: num(rawSettings.interviewResultWaitDays, V1_DEFAULTS.interviewResultWaitDays),
    wishlistExpireDays: num(rawSettings.wishlistExpireDays, V1_DEFAULTS.wishlistExpireDays),
    resultPromptHour: hour(rawSettings.resultPromptHour, V1_DEFAULTS.resultPromptHour),
    channelFactor,
    weeklyApplyGoal: num(rawSettings.weeklyApplyGoal, V1_DEFAULTS.weeklyApplyGoal),
    courseSlots,
    defaultResumeVersion: asOptionalString(rawSettings.defaultResumeVersion) ?? '',
  };
}

/** 把 v1 原始对象归一化。**只读 ctx.nowIso 作为缺失时间戳的兜底** */
export function normalizeV1(raw: Record<string, unknown>, ctx: { nowIso: string }): V1Result {
  const core = normalizeCoreArrays(raw, ctx.nowIso, V1_NOTE_TYPES);
  if (!core.ok) return { ok: false, error: core.error };
  const rawSettings = isRecord(raw.settings) ? raw.settings : {};
  return {
    ok: true,
    data: {
      settings: normalizeV1Settings(rawSettings),
      companies: core.data.companies,
      applications: core.data.applications,
      interviews: core.data.interviews,
      notes: core.data.notes,
    },
  };
}
