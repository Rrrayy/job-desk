/**
 * v2 结构校验：字段级错误（沿用「第 N 条投递缺少 jobTitle」风格）。
 *
 * 宽容度约定（架构 R4）：
 * - `experiences` / `questions` / `staging` 缺失 → 补 `[]`（示例数据与老导出都可能没有它们）
 * - `settings.sync` 缺失 → 补默认值
 * 但**已有的字段类型错了必须报错** —— 静默纠错会让用户以为数据还在。
 */

import type {
  AISuggestion,
  AISuggestionStatus,
  AISuggestionTargetType,
  AppSettings,
  CalendarEvent,
  DB,
  ExperienceResult,
  ExperienceSource,
  InterviewExperience,
  Mastery,
  PlatformId,
  PluginStorage,
  Question,
  QuestionCategory,
  RequestLog,
  RootCause,
  StagedReason,
  StagedSyncItem,
  SyncSettings,
} from '../types';
import type { NormalizedRecord } from '../adapters/types';
import { DEFAULT_SYNC_SETTINGS, defaultSettings } from './defaults';
import {
  SCHEMA_VERSION_CURRENT,
  normalizeAiSettings,
  normalizeBackupReminderDays,
  normalizeEncryptionSettings,
  normalizeFileLinkSettings,
} from './migrate';
import { STAGING_LIMIT } from './sync/engine';
import { V2_NOTE_TYPES, asOptionalString, asString, isRecord, normalizeCoreArrays } from './validateV1';

export type ImportResult = { ok: true; db: DB } | { ok: false; error: string };

const PLATFORMS: PlatformId[] = ['boss', 'shixiseng', 'nowcoder', 'liepin', 'custom'];
const EXPERIENCE_RESULTS: ExperienceResult[] = ['passed', 'failed', 'pending', 'unknown'];
const EXPERIENCE_SOURCES: ExperienceSource[] = ['self', 'community'];
const CATEGORIES: QuestionCategory[] = ['algo', 'concept', 'project', 'behavior', 'reverse', 'hr'];
const ROOT_CAUSES: RootCause[] = ['conceptGap', 'forgot', 'nervous', 'misread', 'neverSeen'];
// 加 'unparsed' 是 QA D1 的直接后果：解析失败的条目现在会真的落进暂存区。
// 如果不在这里放行，下一轮启动 validateV2 就会把「自己刚写的库」判成坏数据 —— 那是更严重的 bug。
const STAGED_REASONS: StagedReason[] = ['unmapped', 'ambiguous', 'conflict', 'unparsed'];
// v0.8：AI 建议的枚举白名单（types.ts 注释约定「枚举只增不改」，这里同步维护）
const AI_TARGET_TYPES: AISuggestionTargetType[] = ['question', 'application_note', 'staging_field'];
const AI_STATUSES: AISuggestionStatus[] = ['pending', 'accepted', 'rejected'];

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
    // schemaVersion 恒等于「当前内部版本」：校验器输出就是当前形状的库
    schemaVersion: SCHEMA_VERSION_CURRENT,
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
    backupReminderDays: normalizeBackupReminderDays(source.backupReminderDays),
    fileLink: normalizeFileLinkSettings(source.fileLink),
    encryption: normalizeEncryptionSettings(source.encryption),
    // v0.8：AI 设置缺省补齐（「未配置」），脏值回落而非报错（与 fileLink 同口径）
    ai: normalizeAiSettings(source.ai),
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

const HHMM_RE = /^\d{2}:\d{2}$/;

/* ---------- v0.8 插件三表（缺失补 []，行级校验沿用同一宽容度约定） ---------- */

/**
 * 插件键值存储：id 物理化联合主键 `${pluginId}::${key}`，按 (pluginId, key) 去重。
 * 同键出现多次时保留最后一条（与「覆盖写」语义一致），绝不静默丢行。
 */
function normalizePluginStorageRow(raw: unknown, index: number): { ok: true; value: PluginStorage } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: `第 ${index + 1} 条插件存储不是对象` };
  const pluginId = asString(raw.pluginId);
  const key = asString(raw.key);
  if (!pluginId) return { ok: false, error: `第 ${index + 1} 条插件存储缺少 pluginId` };
  if (!key) return { ok: false, error: `第 ${index + 1} 条插件存储缺少 key` };
  return {
    ok: true,
    value: {
      id: asString(raw.id) || `${pluginId}::${key}`,
      pluginId,
      key,
      value: raw.value,
      updatedAt: asString(raw.updatedAt) || new Date().toISOString(),
    },
  };
}

/** 审计日志：只有元数据与字段指纹；status 只认 ok / error */
function normalizeRequestLogRow(raw: unknown, index: number): { ok: true; value: RequestLog } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: `第 ${index + 1} 条请求日志不是对象` };
  const id = asString(raw.id);
  const pluginId = asString(raw.pluginId);
  const timestamp = asString(raw.timestamp);
  const status = asString(raw.status);
  if (!id) return { ok: false, error: `第 ${index + 1} 条请求日志缺少 id` };
  if (!pluginId) return { ok: false, error: `第 ${index + 1} 条请求日志缺少 pluginId` };
  if (!timestamp) return { ok: false, error: `第 ${index + 1} 条请求日志缺少 timestamp` };
  if (status !== 'ok' && status !== 'error') {
    return { ok: false, error: `第 ${index + 1} 条请求日志的 status 不合法` };
  }
  const value: RequestLog = {
    id,
    timestamp,
    pluginId,
    baseUrl: asString(raw.baseUrl),
    model: asString(raw.model),
    sentFieldsHash: asString(raw.sentFieldsHash),
    status,
  };
  const errorCode = asOptionalString(raw.errorCode);
  if (errorCode) value.errorCode = errorCode;
  return { ok: true, value };
}

/** AI 建议：逐字段制，枚举白名单校验 */
function normalizeAiSuggestionRow(raw: unknown, index: number): { ok: true; value: AISuggestion } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: `第 ${index + 1} 条 AI 建议不是对象` };
  const id = asString(raw.id);
  const pluginId = asString(raw.pluginId);
  const targetType = asString(raw.targetType);
  const fieldPath = asString(raw.fieldPath);
  const content = asString(raw.content);
  const status = asString(raw.status);
  if (!id) return { ok: false, error: `第 ${index + 1} 条 AI 建议缺少 id` };
  if (!pluginId) return { ok: false, error: `第 ${index + 1} 条 AI 建议缺少 pluginId` };
  if (!AI_TARGET_TYPES.includes(targetType as AISuggestionTargetType)) {
    return { ok: false, error: `第 ${index + 1} 条 AI 建议的 targetType 不合法` };
  }
  if (!fieldPath) return { ok: false, error: `第 ${index + 1} 条 AI 建议缺少 fieldPath` };
  if (!AI_STATUSES.includes(status as AISuggestionStatus)) {
    return { ok: false, error: `第 ${index + 1} 条 AI 建议的 status 不合法` };
  }
  const value: AISuggestion = {
    id,
    pluginId,
    targetType: targetType as AISuggestionTargetType,
    targetId: asOptionalString(raw.targetId) ?? null,
    fieldPath,
    content,
    status: status as AISuggestionStatus,
    createdAt: asString(raw.createdAt) || new Date().toISOString(),
  };
  const evidence = asOptionalString(raw.evidence);
  if (evidence) value.evidence = evidence;
  const decidedAt = asOptionalString(raw.decidedAt);
  if (decidedAt) value.decidedAt = decidedAt;
  return { ok: true, value };
}

/**
 * 三表的公共骨架：缺失 → []（老备份没有它们，与 experiences 同口径）；
 * 不是数组 → 报错；行级校验失败 → 报错（已有数据类型错了必须说，不静默纠错）。
 */
function normalizeV08Table<T>(
  raw: unknown,
  row: (value: unknown, index: number) => { ok: true; value: T } | { ok: false; error: string },
): { ok: true; rows: T[] } | { ok: false; error: string } {
  const list = Array.isArray(raw) ? raw : [];
  const rows: T[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const result = row(list[i], i);
    if (!result.ok) return { ok: false, error: result.error };
    rows.push(result.value);
  }
  return { ok: true, rows };
}

/** 按 (pluginId, key) 去重：同键保留最后一条 */
function dedupePluginStorage(rows: PluginStorage[]): PluginStorage[] {
  const byKey = new Map<string, PluginStorage>();
  for (const row of rows) byKey.set(`${row.pluginId}::${row.key}`, row);
  return [...byKey.values()];
}

/** 归一化一条日程：id/title/时间必填，weekly 决定看 weekday 还是 date */
function normalizeEvent(raw: unknown, index: number): { ok: true; value: CalendarEvent } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: `第 ${index + 1} 条日程不是对象` };
  const id = asString(raw.id);
  const title = asString(raw.title);
  const start = asString(raw.start);
  const end = asString(raw.end);
  if (!id) return { ok: false, error: `第 ${index + 1} 条日程缺少 id` };
  if (!title) return { ok: false, error: `第 ${index + 1} 条日程缺少 title` };
  if (!HHMM_RE.test(start) || !HHMM_RE.test(end)) {
    return { ok: false, error: `第 ${index + 1} 条日程「${title}」的时间必须是 HH:mm` };
  }
  if (start >= end) {
    return { ok: false, error: `第 ${index + 1} 条日程「${title}」的结束时间不晚于开始时间` };
  }
  const weekly = raw.weekly === true;
  // v0.6 additive：kind 扩到四种；未知值一律回落 personal（向后兼容老导出）
  const kind: CalendarEvent['kind'] =
    raw.kind === 'course' || raw.kind === 'interview' || raw.kind === 'deadline' ? raw.kind : 'personal';
  // v0.6 三个可选字段：类型不对就丢掉，不阻断导入（additive 字段不拦老备份）
  const applicationId = asOptionalString(raw.applicationId);
  const color = typeof raw.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.color) ? raw.color : undefined;
  const notes = asOptionalString(raw.notes);
  const extra: Pick<CalendarEvent, 'applicationId' | 'color' | 'notes'> = {};
  if (applicationId) extra.applicationId = applicationId;
  if (color) extra.color = color;
  if (notes) extra.notes = notes;
  if (weekly) {
    const weekday = typeof raw.weekday === 'number' ? Math.round(raw.weekday) : 0;
    if (weekday < 1 || weekday > 7) {
      return { ok: false, error: `每周日程「${title}」的 weekday 必须是 1-7` };
    }
    return { ok: true, value: { id, title, kind, start, end, weekly: true, weekday, ...extra } };
  }
  const date = asString(raw.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: `日程「${title}」的 date 必须是 YYYY-MM-DD` };
  }
  return { ok: true, value: { id, title, kind, start, end, weekly: false, date, ...extra } };
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

  /* ---------- 日程表（v0.4 新增；缺失补 []，与 experiences 同口径） ---------- */
  const rawEvents = Array.isArray(raw.events) ? raw.events : [];
  let events: CalendarEvent[] = [];
  for (let i = 0; i < rawEvents.length; i += 1) {
    const result = normalizeEvent(rawEvents[i], i);
    if (!result.ok) return { ok: false, error: result.error };
    events.push(result.value);
  }

  /* ---------- v0.8 插件三表（缺失补 []；已有行类型错了必须报错） ---------- */
  const storageResult = normalizeV08Table(raw.pluginStorage, normalizePluginStorageRow);
  if (!storageResult.ok) return { ok: false, error: storageResult.error };
  const logResult = normalizeV08Table(raw.requestLog, normalizeRequestLogRow);
  if (!logResult.ok) return { ok: false, error: logResult.error };
  const suggestionResult = normalizeV08Table(raw.aiSuggestions, normalizeAiSuggestionRow);
  if (!suggestionResult.ok) return { ok: false, error: suggestionResult.error };

  const settings = normalizeV2Settings(raw.settings);

  /* ---------- 旧 courseSlots 一次性迁移进 events ---------- */
  // 只在 events 为空、且旧字段里真有课的时候发生；迁移完把旧字段清空，
  // 这样「用户删光所有日程」之后课不会再从旧字段里复活。
  if (events.length === 0 && settings.courseSlots.length > 0) {
    events = settings.courseSlots.map((slot) => ({
      id: `ev_migrated_${slot.weekday}_${slot.start.replace(':', '')}_${slot.name}`,
      title: slot.name || '课程',
      kind: 'course' as const,
      start: /^\d{2}:\d{2}$/.test(slot.start) ? slot.start : '00:00',
      end: /^\d{2}:\d{2}$/.test(slot.end) ? slot.end : '00:00',
      weekly: true,
      weekday: slot.weekday,
    }));
    settings.courseSlots = [];
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
    settings,
    companies: core.data.companies,
    applications: core.data.applications,
    interviews: core.data.interviews,
    notes: core.data.notes,
    experiences,
    questions,
    // 超上限时保留最新的 200 条（与引擎的丢弃策略一致：丢最旧）
    staging: staging.length > STAGING_LIMIT ? staging.slice(staging.length - STAGING_LIMIT) : staging,
    events,
    pluginStorage: dedupePluginStorage(storageResult.rows),
    requestLog: logResult.rows,
    aiSuggestions: suggestionResult.rows,
  };

  return { ok: true, db };
}
