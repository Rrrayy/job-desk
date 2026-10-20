/**
 * v1 → v2 迁移。**纯函数**：
 * - 不读时间（用 ctx.now 注入）
 * - 不碰 DOM / localStorage
 * - 不用随机数
 * - 幂等：输入已是 v2 时 changed=false，原对象一字不改
 * - 只加不减：4 个既有数组原样透传，不重排、不补默认值、不改 time
 */

import type { AppSettings, DB, MigrationRecord } from '../types';
import { DEFAULT_NEW_SETTINGS, DEFAULT_SYNC_SETTINGS } from './defaults';
import { isRecord, normalizeV1 } from './validateV1';

export const SCHEMA_VERSION_V1 = 1;
export const SCHEMA_VERSION_V2 = 2;

export interface MigrateContext {
  now: string;
}

export type MigrateResult =
  | { ok: true; db: DB; changed: boolean }
  | { ok: false; error: string };

/**
 * 解析数据格式版本：settings.schemaVersion → raw.schemaVersion → raw.version（顺序即优先级）。
 * 三者都没有 → 'unknown'（老手工文件当 v1 处理）。
 */
export function resolveSchemaVersion(raw: Record<string, unknown>): number | 'unknown' {
  const settings = isRecord(raw.settings) ? raw.settings : {};
  const value = settings.schemaVersion ?? raw.schemaVersion ?? raw.version;
  if (value === undefined || value === null) return 'unknown';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 'unknown';
}

/**
 * v1 → v2。
 * 迁移产出里的 `lastMigration.backupKey` 先留空，由调用方（loadDB / validateImport）
 * 在真正写好回滚点后回填 —— 迁移函数本身不认识 localStorage。
 */
export function migrateV1ToV2(input: unknown, ctx: MigrateContext): MigrateResult {
  if (!isRecord(input)) return { ok: false, error: '顶层不是一个对象' };

  const version = resolveSchemaVersion(input);
  if (version === SCHEMA_VERSION_V2) {
    // 幂等契约：已是 v2 就原样返回，连 deep-equal 都不用重建
    return { ok: true, db: input as unknown as DB, changed: false };
  }
  if (typeof version === 'number' && version > SCHEMA_VERSION_V2) {
    return {
      ok: false,
      error: `这份备份来自 v${version} 数据格式的新版本，请先升级工具再导入（当前支持到 ${SCHEMA_VERSION_V2}）`,
    };
  }

  const normalized = normalizeV1(input, { nowIso: ctx.now });
  if (!normalized.ok) return { ok: false, error: normalized.error };

  const { settings: v1Settings, companies, applications, interviews, notes } = normalized.data;

  const migration: MigrationRecord = {
    from: SCHEMA_VERSION_V1,
    to: SCHEMA_VERSION_V2,
    at: ctx.now,
    backupKey: '',
  };

  const settings: AppSettings = {
    ...v1Settings,
    schemaVersion: SCHEMA_VERSION_V2,
    // v0.3 新增字段：v1 里根本不存在，用默认值补齐（不是「猜内容」，是补缺省配置）
    offerSilenceDays: DEFAULT_NEW_SETTINGS.offerSilenceDays,
    deadlineWarnDays: DEFAULT_NEW_SETTINGS.deadlineWarnDays,
    dailyActionBudget: DEFAULT_NEW_SETTINGS.dailyActionBudget,
    sync: { ...DEFAULT_SYNC_SETTINGS, statusMapOverrides: {} },
    lastMigration: migration,
  };

  return {
    ok: true,
    db: {
      settings,
      companies,
      applications,
      interviews,
      notes,
      // v2 三个新表：迁移只加，不猜内容
      experiences: [],
      questions: [],
      staging: [],
    },
    changed: true,
  };
}
