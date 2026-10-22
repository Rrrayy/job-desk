/**
 * v1 → v2 迁移。**纯函数**：
 * - 不读时间（用 ctx.now 注入）
 * - 不碰 DOM / localStorage
 * - 不用随机数
 * - 幂等：输入已是 v2 时 changed=false，原对象一字不改
 * - 只加不减：4 个既有数组原样透传，不重排、不补默认值、不改 time
 */

import type { AISettings, AppSettings, CalendarEvent, DB, MigrationRecord } from '../types';
import { DEFAULT_NEW_SETTINGS, DEFAULT_SYNC_SETTINGS, defaultAiSettings } from './defaults';
import { isRecord, normalizeV1 } from './validateV1';
import { validateV2 } from './validateV2';

export const SCHEMA_VERSION_V1 = 1;
export const SCHEMA_VERSION_V2 = 2;
/** v0.6：events additive 扩展 + settings 新字段（见 §2.3 冲突 ③） */
export const SCHEMA_VERSION_V3 = 3;
/** v0.8：插件三表落库 + settings.ai（全部 additive，见 ARCH-v08 A-10） */
export const SCHEMA_VERSION_V4 = 4;
/** 当前支持的最高内部数据版本 */
export const SCHEMA_VERSION_CURRENT = SCHEMA_VERSION_V4;
/**
 * 导出文件格式版本（与内部 schemaVersion **解耦**，见 §2.3 冲突 ②）。
 * v0.4.1 及更早的备份没有这个字段 → 按 1 处理。v0.8：2 → 3（随插件三表）。
 */
export const FORMAT_VERSION_CURRENT = 3;

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
 * 迁移分发入口（名字沿用历史；实际语义是「任意老版本 → 当前版本」）。
 * **幂等**：输入已是当前版本时 changed=false，原对象一字不改。
 *
 * 级联结构（与 v0.6 的 v1→v2→v3 同一模式）：
 * - v1 / unknown → migrateV1ToV2（结构补全）
 * - v1 / v2 / unknown → 抬到 v3 形状（校验 + 补 v0.6 字段 + lastMigration）
 * - v3 → migrateV3ToV4（v0.8：插件三表 + settings.ai）
 *
 * 链式迁移只写**一条** lastMigration 审计：v1 直通当前版本记「1 → 4」，
 * 不把中间步逐条罗列 —— 设置页展示的是「这份数据的来源」，不是迁移日志。
 */
export function migrateV2ToV3(input: unknown, ctx: MigrateContext): MigrateResult {
  if (!isRecord(input)) return { ok: false, error: '顶层不是一个对象' };

  const version = resolveSchemaVersion(input);
  if (version === SCHEMA_VERSION_CURRENT) {
    return { ok: true, db: input as unknown as DB, changed: false };
  }
  if (typeof version === 'number' && version > SCHEMA_VERSION_CURRENT) {
    return {
      ok: false,
      error: `这份备份来自 v${version} 数据格式的新版本，请先升级工具再导入（当前支持到 ${SCHEMA_VERSION_CURRENT}）`,
    };
  }

  // v3 输入直接进入 v0.8 那一步，不重跑 v2→v3 抬升
  if (version === SCHEMA_VERSION_V3) {
    return migrateV3ToV4(input, ctx);
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

  // 中间态：抬到 v3 形状（lastMigration 记下链的起点），随后由 migrateV3ToV4 收尾。
  // schemaVersion 的字面量类型是「当前版本 4」，中间态的 3 只能经 unknown 中转 ——
  // migrateV3ToV4 会立刻把它抬回 4，这个中间值不会出现在任何落库结果里。
  const settings = {
    ...from.settings,
    schemaVersion: SCHEMA_VERSION_V3,
    lastMigration: {
      from: version === 'unknown' ? SCHEMA_VERSION_V1 : version,
      to: SCHEMA_VERSION_V3,
      at: ctx.now,
      backupKey: '',
    },
  } as unknown as AppSettings;
  const v3: DB = {
    ...from,
    settings,
    // events 原样透传：v3 的扩展全是可选字段，老事件缺省即合法
    events: from.events.map((event: CalendarEvent) => ({ ...event })),
  };

  return migrateV3ToV4(v3, ctx);
}

/**
 * v3 → v4（v0.8）。**纯函数、幂等、只加不减**：
 * - 三张插件表（pluginStorage / requestLog / aiSuggestions）：v3 没有这三张表，
 *   落库为空表（若手工文件里真有内容，validateV2 校验后原样保留 —— 绝不静默丢行）；
 * - settings.ai 缺省补齐（「未配置」缺省值，不猜服务地址）；
 * - schemaVersion 3 → 4 + lastMigration 审计（链式迁移保留最初的 from）。
 *
 * 迁移产出里的 `lastMigration.backupKey` 先留空，由调用方（loadDB / validateImport）
 * 在真正写好回滚点后回填 —— 迁移函数本身不认识 localStorage。
 */
export function migrateV3ToV4(input: unknown, ctx: MigrateContext): MigrateResult {
  if (!isRecord(input)) return { ok: false, error: '顶层不是一个对象' };

  const version = resolveSchemaVersion(input);
  if (version === SCHEMA_VERSION_CURRENT) {
    return { ok: true, db: input as unknown as DB, changed: false };
  }
  if (typeof version === 'number' && version > SCHEMA_VERSION_CURRENT) {
    return {
      ok: false,
      error: `这份备份来自 v${version} 数据格式的新版本，请先升级工具再导入（当前支持到 ${SCHEMA_VERSION_CURRENT}）`,
    };
  }
  if (version !== SCHEMA_VERSION_V3) {
    return {
      ok: false,
      error: `这一步只接受 v3 数据，收到的是 ${version === 'unknown' ? '未知版本' : `v${version}`}（v1/v2 请走 migrateV2ToV3 分发入口）`,
    };
  }

  // 幂等保护：v3 结构必须先过校验，否则「迁移」会掩盖真正的损坏
  const verified = validateV2(input);
  if (!verified.ok) return { ok: false, error: `v3 数据结构不合法：${verified.error}` };
  const from = verified.db;

  // 链式迁移保留最初的 from：v1 直通 v4 仍然记「1 → 4」，不是「3 → 4」
  const prevFrom = from.settings.lastMigration?.from;
  const chainFrom = typeof prevFrom === 'number' ? prevFrom : SCHEMA_VERSION_V3;

  const settings: AppSettings = {
    ...from.settings,
    schemaVersion: SCHEMA_VERSION_V4,
    ai: normalizeAiSettings((from.settings as unknown as Record<string, unknown>).ai),
    lastMigration: { from: chainFrom, to: SCHEMA_VERSION_V4, at: ctx.now, backupKey: '' },
  };

  return {
    ok: true,
    db: {
      ...from,
      settings,
      // v0.8 三张插件表：validateV2 已保证数组存在（缺失补 []、行内容校验过），这里原样透传
      pluginStorage: from.pluginStorage,
      requestLog: from.requestLog,
      aiSuggestions: from.aiSuggestions,
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

  // AppSettings.schemaVersion 的类型就是「当前版本」，所以这里只能写字面量式的当前常量 ——
  // 这不是漏改：migrateV2ToV3 会立刻级联抬升并覆写 lastMigration，
  // v1 直通时用户看到的仍然是「from 1 → to 当前版本」。
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
    ai: defaultAiSettings(),
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
      // v0.8 插件三表：空表起步（additive，老数据零影响）
      pluginStorage: [],
      requestLog: [],
      aiSuggestions: [],
    },
    changed: true,
  };
}

/**
 * AI 设置（v0.8）：白名单式重建，缺字段补「未配置」缺省值。
 * 同 normalizeEncryptionSettings 的道理：宁可回落到未配置，也绝不把脏值带进运行时。
 */
export function normalizeAiSettings(value: unknown): AISettings {
  if (!isRecord(value)) return defaultAiSettings();
  const baseURL = typeof value.baseURL === 'string' ? value.baseURL.slice(0, 200) : '';
  const model = typeof value.model === 'string' ? value.model.slice(0, 100) : '';
  const out: AISettings = {
    baseURL,
    model,
    isLocal: value.isLocal === true,
  };
  if (typeof value.apiKey === 'string' && value.apiKey.length > 0) {
    out.apiKey = value.apiKey.slice(0, 200);
  }
  return out;
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
