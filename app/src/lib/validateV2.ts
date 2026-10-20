/**
 * v2 结构校验：字段级错误（沿用「第 N 条投递缺少 jobTitle」风格）。
 *
 * 宽容度约定（架构 R4）：
 * - `experiences` / `questions` / `staging` 缺失 → 补 `[]`（示例数据与老导出都可能没有它们）
 * - `settings.sync` 缺失 → 补默认值
 * 但**已有的字段类型错了必须报错** —— 静默纠错会让用户以为数据还在。
 */

import type {
  AppSettings,
  DB,
  ExperienceResult,
  ExperienceSource,
  InterviewExperience,
  Mastery,
  PlatformId,
  Question,
  QuestionCategory,
  RootCause,
  StagedReason,
  StagedSyncItem,
  SyncSettings,
} from '../types';
import type { NormalizedRecord } from '../adapters/types';
import { DEFAULT_SYNC_SETTINGS, defaultSettings } from './defaults';
import { STAGING_LIMIT } from './sync/engine';
import { V2_NOTE_TYPES, asOptionalString, asString, isRecord, normalizeCoreArrays } from './validateV1';

export type ImportResult = { ok: true; db: DB } | { ok: false; error: string };

const PLATFORMS: PlatformId[] = ['boss', 'shixiseng', 'nowcoder', 'custom'];
const EXPERIENCE_RESULTS: ExperienceResult[] = ['passed', 'failed', 'pending', 'unknown'];
const EXPERIENCE_SOURCES: ExperienceSource[] = ['self', 'community'];
const CATEGORIES: QuestionCategory[] = ['algo', 'concept', 'project', 'behavior', 'reverse', 'hr'];
const ROOT_CAUSES: RootCause[] = ['conceptGap', 'forgot', 'nervous', 'misread', 'neverSeen'];
// 加 'unparsed' 是 QA D1 的直接后果：解析失败的条目现在会真的落进暂存区。
// 如果不在这里放行，下一轮启动 validateV2 就会把「自己刚写的库」判成坏数据 —— 那是更严重的 bug。
const STAGED_REASONS: StagedReason[] = ['unmapped', 'ambiguous', 'conflict', 'unparsed'];

function isPlatform(value: unknown): value is PlatformId {
  return typeof value === 'string' && (PLATFORMS as string[]).includes(value);
}

function num(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value;
}

function positiveInt(value: unknown, fallback: number): number {
  const n = num(value, fallback);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.round(n);
}

function normalizeSyncSettings(raw: unknown): SyncSettings {
  if (!isRecord(raw)) return { ...DEFAULT_SYNC_SETTINGS, statusMapOverrides: {} };
  const overrides: SyncSettings['statusMapOverrides'] = {};
  if (isRecord(raw.statusMapOverrides)) {
    for (const [key, value] of Object.entries(raw.statusMapOverrides)) {
      if (value === null) overrides[key] = null;
      else if (typeof value === 'string') overrides[key] = value as SyncSettings['statusMapOverrides'][string];
    }
  }
  return {
    riskAckAt: asOptionalString(raw.riskAckAt),
    defaultPlatform: isPlatform(raw.defaultPlatform) ? raw.defaultPlatform : DEFAULT_SYNC_SETTINGS.defaultPlatform,
    statusMapOverrides: overrides,
    autoRefreshActivity: raw.autoRefreshActivity !== false,
  };
}

/** 校验并归一化 settings（v2） */
export function normalizeV2Settings(raw: unknown): AppSettings {
  const base = defaultSettings();
  const source = isRecord(raw) ? raw : {};

  const channelFactor = { ...base.channelFactor };
  if (isRecord(source.channelFactor)) {
    for (const key of Object.keys(channelFactor) as Array<keyof typeof channelFactor>) {
      const value = source.channelFactor[key];
      if (typeof value === 'number' && value > 0) channelFactor[key] = value;
    }
  }

  const courseSlots = Array.isArray(source.courseSlots)
    ? source.courseSlots.filter(isRecord).map((slot) => ({
        weekday:
          typeof slot.weekday === 'number' && slot.weekday >= 1 && slot.weekday <= 7 ? slot.weekday : 1,
        start: asString(slot.start) || '00:00',
        end: asString(slot.end) || '00:00',
        name: asString(slot.name),
      }))
    : [];

  const lastMigration = isRecord(source.lastMigration)
    ? {
        from: positiveInt(source.lastMigration.from, 1),
        to: positiveInt(source.lastMigration.to, 2),
        at: asString(source.lastMigration.at) || new Date().toISOString(),
        backupKey: asString(source.lastMigration.backupKey),
      }
    : undefined;

  return {
    schemaVersion: 2,
    warnAfterDays: positiveInt(source.warnAfterDays, base.warnAfterDays),
    staleAfterDays: positiveInt(source.staleAfterDays, base.staleAfterDays),
    interviewResultWaitDays: positiveInt(source.interviewResultWaitDays, base.interviewResultWaitDays),
    wishlistExpireDays: positiveInt(source.wishlistExpireDays, base.wishlistExpireDays),
    resultPromptHour: Math.min(23, Math.max(0, Math.round(num(source.resultPromptHour, base.resultPromptHour)))),
    offerSilenceDays: positiveInt(source.offerSilenceDays, base.offerSilenceDays),
    deadlineWarnDays: positiveInt(source.deadlineWarnDays, base.deadlineWarnDays),
    // 0 是合法值（表示「不折叠」），所以不能用 positiveInt
    dailyActionBudget: Math.min(
      50,
      Math.max(0, Math.round(num(source.dailyActionBudget, base.dailyActionBudget))),
    ),
    channelFactor,
    weeklyApplyGoal: positiveInt(source.weeklyApplyGoal, base.weeklyApplyGoal),
    courseSlots,
    defaultResumeVersion: asOptionalString(source.defaultResumeVersion) ?? '',
    sync: normalizeSyncSettings(source.sync),
    lastMigration,
  };
}

function normalizeExperience(raw: unknown, index: number): { ok: true; value: InterviewExperience } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: `第 ${index + 1} 场面经不是对象` };
  const id = asString(raw.id);
  const companyName = asString(raw.companyName);
  const interviewDate = asString(raw.interviewDate);
  const result = asString(raw.result);
  const source = asString(raw.source);
  if (!id) return { ok: false, error: `第 ${index + 1} 场面经缺少 id` };
  if (!companyName) return { ok: false, error: `第 ${index + 1} 场面经缺少 companyName` };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(interviewDate)) {
    return { ok: false, error: `第 ${index + 1} 场面经的 interviewDate 必须是 YYYY-MM-DD` };
  }
  if (!EXPERIENCE_RESULTS.includes(result as ExperienceResult)) {
    return { ok: false, error: `第 ${index + 1} 场面经的 result 不合法` };
  }
  if (!EXPERIENCE_SOURCES.includes(source as ExperienceSource)) {
    return { ok: false, error: `第 ${index + 1} 场面经的 source 不合法` };
  }
  return {
    ok: true,
    value: {
      id,
      applicationId: asOptionalString(raw.applicationId) ?? null,
      companyName,
      jobTitle: asOptionalString(raw.jobTitle),
      round: typeof raw.round === 'number' && raw.round > 0 ? raw.round : null,
      interviewDate,
      result: result as ExperienceResult,
      overallNote: asOptionalString(raw.overallNote),
      source: source as ExperienceSource,
      originFile: asOptionalString(raw.originFile),
      createdAt: asString(raw.createdAt) || new Date().toISOString(),
      updatedAt: asString(raw.updatedAt) || new Date().toISOString(),
    },
  };
}

function normalizeQuestion(raw: unknown, index: number): { ok: true; value: Question } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: `第 ${index + 1} 道题不是对象` };
  const id = asString(raw.id);
  const experienceId = asString(raw.experienceId);
  const text = asString(raw.text);
  if (!id) return { ok: false, error: `第 ${index + 1} 道题缺少 id` };
  if (!experienceId) return { ok: false, error: `第 ${index + 1} 道题缺少 experienceId` };
  if (!text) return { ok: false, error: `第 ${index + 1} 道题缺少 text` };
  const category = raw.category === null || raw.category === undefined ? null : asString(raw.category);
  if (category !== null && !CATEGORIES.includes(category as QuestionCategory)) {
    return { ok: false, error: `第 ${index + 1} 道题的 category 不合法` };
  }
  const masteryRaw = typeof raw.mastery === 'number' ? raw.mastery : 0;
  if (masteryRaw !== 0 && masteryRaw !== 1 && masteryRaw !== 2) {
    return { ok: false, error: `第 ${index + 1} 道题的 mastery 必须是 0/1/2` };
  }
  const difficulty = typeof raw.difficulty === 'number' ? Math.round(raw.difficulty) : 2;
  if (difficulty !== 1 && difficulty !== 2 && difficulty !== 3) {
    return { ok: false, error: `第 ${index + 1} 道题的 difficulty 必须是 1/2/3` };
  }
  const rootCause = asOptionalString(raw.rootCause);
  if (rootCause && !ROOT_CAUSES.includes(rootCause as RootCause)) {
    return { ok: false, error: `第 ${index + 1} 道题的 rootCause 不合法` };
  }
  return {
    ok: true,
    value: {
      id,
      experienceId,
      category: category as QuestionCategory | null,
      difficulty: difficulty as 1 | 2 | 3,
      text,
      myAnswer: asOptionalString(raw.myAnswer),
      mastery: masteryRaw as Mastery,
      rootCause: rootCause as RootCause | undefined,
      nextTime: asOptionalString(raw.nextTime),
      tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      nextReviewAt: asOptionalString(raw.nextReviewAt),
      reviewCount: typeof raw.reviewCount === 'number' && raw.reviewCount >= 0 ? Math.round(raw.reviewCount) : 0,
      lastReviewedAt: asOptionalString(raw.lastReviewedAt),
      createdAt: asString(raw.createdAt) || new Date().toISOString(),
      updatedAt: asString(raw.updatedAt) || new Date().toISOString(),
    },
  };
}

function normalizeStaged(raw: unknown, index: number): { ok: true; value: StagedSyncItem } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: `第 ${index + 1} 条暂存不是对象` };
  const id = asString(raw.id);
  if (!id) return { ok: false, error: `第 ${index + 1} 条暂存缺少 id` };
  if (!isPlatform(raw.platform)) return { ok: false, error: `第 ${index + 1} 条暂存的 platform 不合法` };
  const reason = asString(raw.reason);
  if (!STAGED_REASONS.includes(reason as StagedReason)) {
    return { ok: false, error: `第 ${index + 1} 条暂存的 reason 不合法` };
  }
  const parsedRaw = isRecord(raw.parsed) ? raw.parsed : {};
  const parsed: NormalizedRecord = {
    externalId: asOptionalString(parsedRaw.externalId),
    companyName: asString(parsedRaw.companyName) || '（未识别公司）',
    jobTitle: asOptionalString(parsedRaw.jobTitle),
    city: asOptionalString(parsedRaw.city),
    status: asOptionalString(parsedRaw.status),
    platformStatusText: asOptionalString(parsedRaw.platformStatusText),
    lastContactAt: asOptionalString(parsedRaw.lastContactAt),
    salaryText: asOptionalString(parsedRaw.salaryText),
    jdUrl: asOptionalString(parsedRaw.jdUrl),
    rawSnippet: asOptionalString(parsedRaw.rawSnippet),
    confidence: isRecord(parsedRaw.confidence)
      ? (parsedRaw.confidence as NormalizedRecord['confidence'])
      : {},
    overall: parsedRaw.overall === 'high' || parsedRaw.overall === 'medium' || parsedRaw.overall === 'low'
      ? parsedRaw.overall
      : 'low',
  };
  return {
    ok: true,
    value: {
      id,
      platform: raw.platform,
      externalId: asOptionalString(raw.externalId),
      parsed,
      candidateAppId: asOptionalString(raw.candidateAppId),
      reason: reason as StagedReason,
      platformStatusRaw: asOptionalString(raw.platformStatusRaw),
      rawSnippet: asOptionalString(raw.rawSnippet),
      reasonText: asOptionalString(raw.reasonText),
      capturedAt: asString(raw.capturedAt) || new Date().toISOString(),
    },
  };
}

/** v2 校验器：字段级错误 + 新三表的引用完整性 */
export function validateV2(raw: unknown): ImportResult {
  if (!isRecord(raw)) return { ok: false, error: '顶层不是一个对象' };
  if (!('settings' in raw) && !('applications' in raw)) {
    return { ok: false, error: '缺少 settings / applications 字段，这不像是本应用导出的备份' };
  }

  const core = normalizeCoreArrays(raw, new Date().toISOString(), V2_NOTE_TYPES);
  if (!core.ok) return { ok: false, error: core.error };

  const rawExperiences = Array.isArray(raw.experiences) ? raw.experiences : [];
  const experiences: InterviewExperience[] = [];
  for (let i = 0; i < rawExperiences.length; i += 1) {
    const result = normalizeExperience(rawExperiences[i], i);
    if (!result.ok) return { ok: false, error: result.error };
    experiences.push(result.value);
  }

  const rawQuestions = Array.isArray(raw.questions) ? raw.questions : [];
  const questions: Question[] = [];
  for (let i = 0; i < rawQuestions.length; i += 1) {
    const result = normalizeQuestion(rawQuestions[i], i);
    if (!result.ok) return { ok: false, error: result.error };
    questions.push(result.value);
  }

  const rawStaging = Array.isArray(raw.staging) ? raw.staging : [];
  const staging: StagedSyncItem[] = [];
  for (let i = 0; i < rawStaging.length; i += 1) {
    const result = normalizeStaged(rawStaging[i], i);
    if (!result.ok) return { ok: false, error: result.error };
    staging.push(result.value);
  }

  /* ---------- 引用完整性 ---------- */
  const appIds = new Set(core.data.applications.map((app) => app.id));
  for (const experience of experiences) {
    if (experience.applicationId && !appIds.has(experience.applicationId)) {
      return {
        ok: false,
        error: `面经「${experience.companyName}」引用了不存在的投递（${experience.applicationId}）`,
      };
    }
  }
  const experienceIds = new Set(experiences.map((experience) => experience.id));
  for (const question of questions) {
    if (!experienceIds.has(question.experienceId)) {
      return { ok: false, error: `题目「${question.text.slice(0, 20)}」引用了不存在的面经` };
    }
  }

  const db: DB = {
    settings: normalizeV2Settings(raw.settings),
    companies: core.data.companies,
    applications: core.data.applications,
    interviews: core.data.interviews,
    notes: core.data.notes,
    experiences,
    questions,
    // 超上限时保留最新的 200 条（与引擎的丢弃策略一致：丢最旧）
    staging: staging.length > STAGING_LIMIT ? staging.slice(staging.length - STAGING_LIMIT) : staging,
  };

  return { ok: true, db };
}
