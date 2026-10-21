/**
 * v1 → v2 迁移。**纯函数**：
 * - 不读时间（用 ctx.now 注入）
 * - 不碰 DOM / localStorage
 * - 不用随机数
 * - 幂等：输入已是 v2 时 changed=false，原对象一字不改
 * - 只加不减：4 个既有数组原样透传，不重排、不补默认值、不改 time
 */

import type { AppSettings, CalendarEvent, DB, MigrationRecord } from '../types';
import { DEFAULT_NEW_SETTINGS, DEFAULT_SYNC_SETTINGS } from './defaults';
import { isRecord, normalizeV1 } from './validateV1';
import { validateV2 } from './validateV2';

export const SCHEMA_VERSION_V1 = 1;
export const SCHEMA_VERSION_V2 = 2;
/** v0.6：events additive 扩展 + settings 新字段（见 §2.3 冲突 ③） */
export const SCHEMA_VERSION_V3 = 3;
/** 当前支持的最高内部数据版本 */
export const SCHEMA_VERSION_CURRENT = SCHEMA_VERSION_V3;
/**
 * 导出文件格式版本（与内部 schemaVersion **解耦**，见 §2.3 冲突 ②）。
 * v0.4.1 及更早的备份没有这个字段 → 按 1 处理。
 */
export const FORMAT_VERSION_CURRENT = 2;

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
 * v1/v2 → v3。**幂等**：已是 v3 时 changed=false、原对象一字不改。
 *
 * v3 相对 v2 的差别只有 additive 扩展，所以这一步不需要重建任何数组：
 * - events 的 kind 扩到四种、加 applicationId/color/notes —— 老数据没有这些字段，
 *   缺省即合法（`validateV2` 的可选字段逻辑已经兼容）。
 * - settings 加两个 v0.6 字段：backupReminderDays（备份提醒天数）、
 *   fileLink（文件联动配置，默认关闭）。
 *
 * **不补 events 的默认值**：老库里的事件保持原样，不凭空添加 color / notes。
 */
export function migrateV2ToV3(input: unknown, ctx: MigrateContext): MigrateResult {
  if (!isRecord(input)) return { ok: false, error: '顶层不是一个对象' };

  const version = resolveSchemaVersion(input);
  if (version === SCHEMA_VERSION_V3) {
    return { ok: true, db: input as unknown as DB, changed: false };
  }
  if (typeof version === 'number' && version > SCHEMA_VERSION_CURRENT) {
    return {
      ok: false,
      error: `这份备份来自 v${version} 数据格式的新版本，请先升级工具再导入（当前支持到 ${SCHEMA_VERSION_CURRENT}）`,
    };
  }

  // v1 → v2 的产物是完整的 v2 库；v2 输入本身就按 v2 处理
  let base: DB;
  if (version === SCHEMA_VERSION_V1 || version === 'unknown') {
    const step1 = migrateV1ToV2(input, ctx);
    if (!step1.ok) return step1;
    base = step1.db;
  } else {
    base = input as unknown as DB;
  }

  // 幂等保护：v2 结构必须先过校验，否则「迁移」会掩盖真正的损坏
  const verified = validateV2(base);
  if (!verified.ok) return { ok: false, error: `v2 数据结构不合法：${verified.error}` };
  const from = verified.db;

  const settings: AppSettings = {
    ...from.settings,
    schemaVersion: SCHEMA_VERSION_V3,
    backupReminderDays: normalizeBackupReminderDays(
      (from.settings as unknown as Record<string, unknown>).backupReminderDays,
    ),
    fileLink: normalizeFileLinkSettings((from.settings as unknown as Record<string, unknown>).fileLink),
    encryption: normalizeEncryptionSettings(
      (from.settings as unknown as Record<string, unknown>).encryption,
    ),
    lastMigration: { from: version === 'unknown' ? SCHEMA_VERSION_V1 : version, to: SCHEMA_VERSION_V3, at: ctx.now, backupKey: '' },
  };

  return {
    ok: true,
    db: {
      ...from,
      settings,
      // events 原样透传：v3 的扩展全是可选字段，老事件缺省即合法
      events: from.events.map((event: CalendarEvent) => ({ ...event })),
    },
    changed: true,
  };
}

/**
 * v1 → v2 结构补全（v0.6 起由 `migrateV2ToV3` 内部调用，不再直接对外分发）。
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

  // AppSettings.schemaVersion 的类型就是「当前版本」，所以这里只能写字面量 3 ——
  // 这不是漏改：migrateV2ToV3 会立刻把同一份对象抬到 v3 并覆写 lastMigration，
  // v1 直通 v3 时用户看到的仍然是「from 1 → to 3」。
  const settings: AppSettings = {
    ...v1Settings,
    schemaVersion: SCHEMA_VERSION_CURRENT,
    // v0.3 新增字段：v1 里根本不存在，用默认值补齐（不是「猜内容」，是补缺省配置）
    offerSilenceDays: DEFAULT_NEW_SETTINGS.offerSilenceDays,
    deadlineWarnDays: DEFAULT_NEW_SETTINGS.deadlineWarnDays,
    dailyActionBudget: DEFAULT_NEW_SETTINGS.dailyActionBudget,
    sync: { ...DEFAULT_SYNC_SETTINGS, statusMapOverrides: {} },
    // v0.6 两个新字段：同样属于「v1 里不存在，补缺省配置」
    backupReminderDays: normalizeBackupReminderDays(undefined),
    fileLink: normalizeFileLinkSettings(undefined),
    encryption: normalizeEncryptionSettings(undefined),
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
      // v0.4 日程表：空表起步；v1 的 courseSlots 由 validateV2 的一次性迁移接走
      events: [],
    },
    changed: true,
  };
}

/* ==================== v0.6 新字段的清洗（迁移与校验共用） ==================== */

/** 备份提醒天数只接受 0/3/7/14，其余回落 7 */
export function normalizeBackupReminderDays(value: unknown): number {
  return value === 0 || value === 3 || value === 7 || value === 14 ? value : 7;
}

/** 文件联动设置：缺字段补默认，类型错就回落（绝不因为一个可选字段拦住整个导入） */
export function normalizeFileLinkSettings(value: unknown): DB['settings']['fileLink'] {
  if (!isRecord(value)) return { enabled: false, readOnly: false };
  const out: DB['settings']['fileLink'] = {
    enabled: value.enabled === true,
    readOnly: value.readOnly === true,
  };
  if (typeof value.lastSyncedAt === 'string' && !Number.isNaN(Date.parse(value.lastSyncedAt))) {
    out.lastSyncedAt = value.lastSyncedAt;
  }
  if (typeof value.lastConflictFile === 'string' && value.lastConflictFile.length <= 200) {
    out.lastConflictFile = value.lastConflictFile;
  }
  return out;
}

/**
 * 加密设置：只保留 `enabled` 与 `changedAt`。
 *
 * ★ 白名单式重建，不是 `{...value}` —— 这是唯一能保证
 *   「备份文件里永远不会出现口令/密钥/salt」的实现方式。
 *   就算有人手工往 settings.encryption 里塞了 `password: "123456"`，
 *   过一遍这里也就被丢掉了。
 */
export function normalizeEncryptionSettings(value: unknown): DB['settings']['encryption'] {
  if (!isRecord(value)) return { enabled: false };
  const out: DB['settings']['encryption'] = { enabled: value.enabled === true };
  if (typeof value.changedAt === 'string' && !Number.isNaN(Date.parse(value.changedAt))) {
    out.changedAt = value.changedAt;
  }
  return out;
}
