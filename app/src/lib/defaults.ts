/**
 * 默认值集中在这里，而不是 storage.ts —— 目的是**打断循环依赖**：
 * storage → validateV2/migrate →（需要默认值）→ storage 会形成环。
 * 默认值没有任何依赖，放在最底层最安全。storage.ts 仍然原样 re-export 这两个函数，
 * 所以 `import { defaultSettings } from './storage'` 这类既有写法不受影响。
 */

import type { AppSettings, AppSettings as Settings, DB, SyncSettings } from '../types';

export const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  riskAckAt: undefined,
  defaultPlatform: 'boss',
  statusMapOverrides: {},
  autoRefreshActivity: true,
};

/**
 * v0.3 新增的 settings 字段默认值。
 *
 * 单独导出，是为了让 migrate.ts 只补这几个缺的键，而不是把整个默认对象铺上去 ——
 * 后者会把 v1 里用户改过的阈值（warnAfterDays 等）一起覆盖成出厂值。
 */
export const DEFAULT_NEW_SETTINGS = {
  offerSilenceDays: 7,
  deadlineWarnDays: 3,
  dailyActionBudget: 5,
} as const;

/** 默认设置（schemaVersion 2） */
export function defaultSettings(): Settings {
  return {
    schemaVersion: 2,
    warnAfterDays: 3,
    staleAfterDays: 7,
    interviewResultWaitDays: 5,
    wishlistExpireDays: 7,
    resultPromptHour: 20,
    ...DEFAULT_NEW_SETTINGS,
    channelFactor: {
      referral: 3,
      official: 2,
      boss: 1,
      shixiseng: 1,
      nowcoder: 1,
      other: 1,
    },
    weeklyApplyGoal: 8,
    courseSlots: [],
    defaultResumeVersion: '',
    sync: { ...DEFAULT_SYNC_SETTINGS, statusMapOverrides: {} },
    lastMigration: undefined,
  };
}

/** 空数据库（含 v2 三个新数组 + v0.4 日程表） */
export function emptyDB(): DB {
  return {
    settings: defaultSettings(),
    companies: [],
    applications: [],
    interviews: [],
    notes: [],
    experiences: [],
    questions: [],
    staging: [],
    events: [],
  };
}

/** 供 UI 读取时的兜底（防御历史数据里 settings 缺字段） */
export function settingsWithDefaults(partial: Partial<AppSettings> | undefined): AppSettings {
  const base = defaultSettings();
  if (!partial) return base;
  return {
    ...base,
    ...partial,
    channelFactor: { ...base.channelFactor, ...(partial.channelFactor ?? {}) },
    courseSlots: partial.courseSlots ?? base.courseSlots,
    sync: { ...base.sync, ...(partial.sync ?? {}) },
  };
}
