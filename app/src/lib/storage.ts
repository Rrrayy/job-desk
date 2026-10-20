/**
 * localStorage 持久化 + JSON 导入导出 + schema 校验分发。
 *
 * 铁律：读失败绝不允许白屏 —— 降级为空数据 + 提示「数据已损坏，可导出修复」。
 *
 * ★ 语义提醒（架构 D-05）：`validateImport` 的名字是「校验」，但它同时负责**迁移**：
 *   v1 → migrateV1ToV2，v2 → validateV2。启动与导入共用这一个入口，
 *   所以「v1 备份导入 v0.2」与「启动时自动迁移」物理上是同一份实现，不可能漂移。
 */

import type { DB, PlatformId, Status } from '../types';
import type { InsightsTab } from './api';
import { BUDGET } from './budget';
import { defaultSettings, emptyDB } from './defaults';
import { migrateV1ToV2, resolveSchemaVersion } from './migrate';
import {
  BACKUP_KEY_PREFIX,
  readPointer,
  sweepRollbackPoints,
  writePointer,
  writeRollbackPoint,
} from './rollback';
import { type ImportResult, validateV2 } from './validateV2';

export { defaultSettings, emptyDB };
export type { ImportResult };

const STORAGE_KEY = 'jobdesk.v1';
const UI_KEY = 'jobdesk.v1.ui';
/**
 * 读取失败时，原始字符串的隔离副本前缀（QA D4）。
 * 为什么不是「回滚点」：回滚点只覆盖 v1 → v2 迁移成功前后的场景；
 * 这里的「读不出来」包括非 JSON、v2 校验失败、更新版本的数据 —— 它们没有迁移可言，
 * 但同样必须有一份原文能被用户取回。
 */
const FAILED_KEY_PREFIX = 'jobdesk.v1.failedAt.';
/** 列表筛选条件的持久化 key（QA D7） */
const LIST_FILTER_KEY = 'jobdesk.v1.listFilters';

/* ------------------------- 写盘闸门（QA D4 的一半） ------------------------- */

/**
 * 全局写盘闸门。
 *
 * 背景（真实事故）：启动时 `loadDB()` 读失败会返回 `emptyDB()`，
 * 而 App 的 `useEffect(..., [db])` 在「渲染失败页并 return」**之前**就已经注册，
 * 于是一次渲染就把 `jobdesk.v1` 写成 485 字节的空骨架 —— 用户 12KB 的数据永久消失。
 *
 * 修法不能靠「渲染顺序上别赌」：闸门放在 storage 这一层，
 * 只要闸门锁着，**任何**对 `saveDB` 的调用都是无操作（且不报错，UI 正在失败页上）。
 * 解锁只有两个时机：重试成功（`boot.migration` 消失），或用户明确点了「用空数据进入」。
 */
let persistenceLocked = false;

export function lockPersistence(): void {
  persistenceLocked = true;
}

export function unlockPersistence(): void {
  persistenceLocked = false;
}

export function isPersistenceLocked(): boolean {
  return persistenceLocked;
}

/** 仅供测试使用：把闸门恢复到初始态，避免用例之间互相污染 */
export function resetPersistenceLock(): void {
  persistenceLocked = false;
}

/** 视图状态：v0.1 存的是裸字符串，v0.2 存 JSON（key 不变，架构 §2.9） */
export interface UIViewState {
  view: string;
  insightsTab: InsightsTab;
}

export interface LoadResult {
  db: DB;
  /** v0.1 语义不变：读到了但解析失败（降级空数据）时的提示文案 */
  error: string | null;
  /** v2 新增：迁移失败时 UI 必须渲染 MigrationFailPage 而不是主界面 */
  migration?: {
    failed: true;
    from: number;
    backupKey: string | null;
    /** 读失败那一刻把 raw 原文另存的 key（QA D4），失败页上要把它显示出来 */
    failedAtKey: string | null;
    /** 原始字符串（≤ 8 MB 内存占用可接受），供「下载原始」直接用 */
    raw: string;
    reason: string;
  };
}

/**
 * 把读不出来的原始字符串另存一份，返回它的 key。
 *
 * 三条要求（QA D4）：
 * 1. 必须在任何可能覆盖 `jobdesk.v1` 的动作**之前**调用；
 * 2. 幂等 —— 同样的内容不重复存（用户刷新 10 次不该留 10 份）；
 * 3. 有上限 —— 最多留 3 份，超了丢最旧的（不然坏数据会把配额吃光，反而导致真数据写不进去）。
 */
export function preserveFailedRaw(raw: string, nowIso: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const existing = listKeysWithPrefix(FAILED_KEY_PREFIX);
    // 2. 内容相同就复用，不重复写
    for (const key of existing) {
      if (localStorage.getItem(key) === raw) return key;
    }
    const key = `${FAILED_KEY_PREFIX}${nowIso.replace(/[:.]/g, '-')}`;
    localStorage.setItem(key, raw);
    // 3. 最多 3 份：key 里带 ISO 时间，字典序 = 时间序，直接切最旧的
    const after = listKeysWithPrefix(FAILED_KEY_PREFIX).sort();
    for (const stale of after.slice(0, Math.max(0, after.length - 3))) {
      localStorage.removeItem(stale);
    }
    return key;
  } catch {
    // 存不下（配额满）也不能拦住用户下载：raw 已经在内存里，失败页照样能用
    return null;
  }
}

function listKeysWithPrefix(prefix: string): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
  } catch {
    return [];
  }
  return keys;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 版本分发（替代 v0.1 的 `version !== 1` 判定）。
 * 老手工文件没有版本号 → 当 v1 处理，走同一条迁移。
 */
export function validateImport(raw: unknown): ImportResult {
  if (!isRecord(raw)) return { ok: false, error: '顶层不是一个对象' };
  if (!('settings' in raw) && !('applications' in raw)) {
    return { ok: false, error: '缺少 settings / applications 字段，这不像是本应用导出的备份' };
  }

  const version = resolveSchemaVersion(raw);
  if (version === 2) return validateV2(raw);
  if (version === 1 || version === 'unknown') {
    // §D.3：v1 备份导入必须成功，且走同一条迁移
    const migrated = migrateV1ToV2(raw, { now: new Date().toISOString() });
    if (!migrated.ok) return { ok: false, error: migrated.error };
    // 迁移产物过一遍 v2 校验，避免「迁移写出一个自己都读不回来的库」
    return validateV2(migrated.db);
  }
  return {
    ok: false,
    error:
      version > 2
        ? `这份备份来自 v${version} 数据格式的新版本，请先升级工具再导入（当前支持到 2）`
        : `无法识别的数据格式版本：${String(version)}`,
  };
}

/**
 * 从 localStorage 读取；任何异常都降级为空数据。
 *
 * ★ QA D4：只要读失败（`migration.failed === true`），**在返回之前就上锁**。
 * 这样「App 的 effect 先跑还是 return 先返回」就完全不重要了 ——
 * 锁是在读的一瞬间上的，任何后续的 `saveDB` 都是空操作。
 * 解锁只有两个出口：重试成功、或用户明确点了「用空数据进入」。
 */
export function loadDB(): LoadResult {
  const result = readDB();
  if (result.migration?.failed) lockPersistence();
  return result;
}

function readDB(): LoadResult {
  if (typeof localStorage === 'undefined') {
    return { db: emptyDB(), error: '当前浏览器不支持本地存储，数据不会被保存。' };
  }

  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return { db: emptyDB(), error: '浏览器禁止了本地存储，数据无法保存。请检查隐私设置。' };
  }
  if (!raw) return { db: emptyDB(), error: null };

  sweepRollbackPoints(new Date().toISOString());

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const failedAtKey = preserveFailedRaw(raw, new Date().toISOString());
    return {
      db: emptyDB(),
      error: '数据已损坏（不是合法的 JSON），可下载原始数据后修复。已临时降级为空数据。',
      migration: {
        failed: true,
        from: 1,
        backupKey: null,
        failedAtKey,
        raw,
        reason: '存储里的内容不是合法的 JSON —— 可能是手动编辑过，或写入过程中被中断',
      },
    };
  }

  if (!isRecord(parsed)) {
    const failedAtKey = preserveFailedRaw(raw, new Date().toISOString());
    return {
      db: emptyDB(),
      error: '数据已损坏（顶层不是一个对象），可下载原始数据后修复。',
      migration: {
        failed: true,
        from: 1,
        backupKey: null,
        failedAtKey,
        raw,
        reason: '存储里的内容顶层不是一个对象',
      },
    };
  }

  const version = resolveSchemaVersion(parsed);

  // 已经是 v2：直接校验
  if (version === 2) {
    const result = validateV2(parsed);
    if (result.ok) return { db: result.db, error: null };
    const failedAtKey = preserveFailedRaw(raw, new Date().toISOString());
    return {
      db: emptyDB(),
      error: `数据已损坏（${result.error}），可下载原始数据后修复。已临时降级为空数据。`,
      migration: {
        failed: true,
        from: 2,
        backupKey: null,
        failedAtKey,
        raw,
        reason: result.error,
      },
    };
  }

  if (typeof version === 'number' && version > 2) {
    const failedAtKey = preserveFailedRaw(raw, new Date().toISOString());
    return {
      db: emptyDB(),
      error: `数据来自更新版本（v${version}），当前工具最高支持 v2。`,
      migration: {
        failed: true,
        from: version,
        backupKey: null,
        failedAtKey,
        raw,
        reason: `数据来自 v${version}（比当前版本新），请升级工具`,
      },
    };
  }

  /* ---------- v1 / unknown：先备份，再迁移 ---------- */
  const nowIso = new Date().toISOString();
  const backup = writeRollbackPoint(raw, nowIso);
  if (!backup.ok) {
    // 契约 5：备份失败必须中止迁移，原数据一字未动
    const failedAtKey = preserveFailedRaw(raw, nowIso);
    return {
      db: emptyDB(),
      error: `迁移已中止：${backup.error}。原数据没有被改动。`,
      migration: {
        failed: true,
        from: 1,
        backupKey: null,
        failedAtKey,
        raw,
        reason: `${backup.error}。为了避免在没有退路的情况下改数据，迁移已中止`,
      },
    };
  }

  const migrated = migrateV1ToV2(parsed, { now: nowIso });
  if (!migrated.ok) {
    writePointer({ from: 1, to: 2, at: nowIso, backupKey: backup.key, status: 'failed', reason: migrated.error });
    return {
      db: emptyDB(),
      error: `迁移失败：${migrated.error}。原数据没有被改动，回滚点已保留。`,
      migration: { failed: true, from: 1, backupKey: backup.key, failedAtKey: backup.key, raw, reason: migrated.error },
    };
  }

  const verified = validateV2(migrated.db);
  if (!verified.ok) {
    writePointer({ from: 1, to: 2, at: nowIso, backupKey: backup.key, status: 'failed', reason: verified.error });
    return {
      db: emptyDB(),
      error: `迁移结果校验失败：${verified.error}。原数据没有被改动，回滚点已保留。`,
      migration: { failed: true, from: 1, backupKey: backup.key, failedAtKey: backup.key, raw, reason: verified.error },
    };
  }

  const db = verified.db;
  db.settings.lastMigration = { from: 1, to: 2, at: nowIso, backupKey: backup.key };
  const writeError = writeDB(db);
  if (writeError) {
    // 写不进去也不能白屏：把数据交出去，让用户先导出
    return {
      db,
      error: `${writeError} 迁移结果已在内存中，请立刻导出备份。`,
    };
  }
  writePointer({ from: 1, to: 2, at: nowIso, backupKey: backup.key, status: 'done' });
  return { db, error: null };
}

/**
 * 真正写盘（不做闸门判断）。只给「迁移已经成功、必须落盘」的路径用。
 * 任何 UI 触发的写入都必须走 `saveDB`，否则 D4 那个洞会重开。
 *
 * ★ v0.3 性能：只序列化**一次**。
 *   原来是先 `measureDB(db)`（内部也是 JSON.stringify）再 `JSON.stringify(db)` 写盘，
 *   同一份数据被完整字符串化两遍 —— 这是写路径上最贵的一步。
 *   现在量长度直接用序列化结果的 `.length`，语义完全等价（measureDB 本来就等于这个），成本减半。
 */
function writeDB(db: DB): string | null {
  let text: string;
  try {
    text = JSON.stringify(db);
  } catch {
    return '保存失败：数据无法被序列化（可能存在循环引用）。请立刻导出备份。';
  }
  const size = text.length;
  if (size >= BUDGET.block) {
    return `数据已达约 ${Math.round(size / 10000) / 100} 万字符，超过安全上限，已暂停写入。请先导出备份，再清理一批已结束的投递。`;
  }
  try {
    localStorage.setItem(STORAGE_KEY, text);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return `保存失败（${message}）。可能是浏览器存储空间不足或被禁用。请立刻导出备份。`;
  }
}

/**
 * 写回 localStorage（体积 block 时拒绝写入，让用户先导出）。
 *
 * ★ QA D4 的硬门槛：闸门锁着时**直接返回、什么都不写**。
 * 这不是「防御性编程」，是那起「一次渲染把 12KB 数据写成 485 字节空骨架」事故的正面修复。
 * 判断必须发生在这里，而不是在 App 的渲染路径里赌 effect 与 return 的先后。
 */
export function saveDB(db: DB): string | null {
  if (persistenceLocked) return null;
  if (typeof localStorage === 'undefined') return null;
  return writeDB(db);
}

/* ---------------------------- 视图状态记忆 ---------------------------- */

/**
 * 兼容两种历史值：
 * - v0.1 写入的是裸字符串 'board'
 * - v0.2 写入 '{"view":"insights","insightsTab":"interview"}'
 */
export function loadUIView(): UIViewState | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(UI_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  if (raw.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) return null;
      const view = typeof parsed.view === 'string' ? parsed.view : 'today';
      const tab: InsightsTab = parsed.insightsTab === 'interview' ? 'interview' : 'data';
      return { view, insightsTab: tab };
    } catch {
      return null;
    }
  }
  return { view: raw, insightsTab: 'data' };
}

export function saveUIView(state: UIViewState): void {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify(state));
  } catch {
    // 视图记忆失败不影响主流程
  }
}

/* ------------------------- 列表筛选记忆（QA D7） ------------------------- */

/**
 * 列表页的筛选/排序条件。
 *
 * 为什么值得单独存：用户筛出「北京 · 内推 · 简历 v3 · 已沟通」，看了一圈再刷新就回到全量，
 * 等于每次都要重筛一遍。这不是「锦上添花」，是列表页的可用性。
 */
export interface ListFilterState {
  status: string;
  channel: string;
  version: string;
  cities: string[];
  keyword: string;
  sortKey: string;
  sortDir: 'asc' | 'desc';
}

export const DEFAULT_LIST_FILTERS: ListFilterState = {
  status: 'all',
  channel: 'all',
  version: 'all',
  cities: [],
  keyword: '',
  sortKey: 'silence',
  sortDir: 'desc',
};

/**
 * 把任意值收敛成合法的筛选条件（纯函数，可单测）。
 * 原则：**认不出来的一律回默认值**，绝不因为一条脏缓存把列表筛成空的。
 */
export function sanitizeListFilters(raw: unknown): ListFilterState | null {
  if (!isRecord(raw)) return null;
  const asText = (value: unknown, fallback: string): string =>
    typeof value === 'string' ? value : fallback;
  const cities = Array.isArray(raw.cities)
    ? raw.cities.filter((item): item is string => typeof item === 'string').slice(0, 40)
    : [];
  return {
    status: asText(raw.status, DEFAULT_LIST_FILTERS.status),
    channel: asText(raw.channel, DEFAULT_LIST_FILTERS.channel),
    version: asText(raw.version, DEFAULT_LIST_FILTERS.version),
    cities,
    keyword: asText(raw.keyword, DEFAULT_LIST_FILTERS.keyword).slice(0, 100),
    sortKey: asText(raw.sortKey, DEFAULT_LIST_FILTERS.sortKey),
    sortDir: raw.sortDir === 'asc' || raw.sortDir === 'desc' ? raw.sortDir : DEFAULT_LIST_FILTERS.sortDir,
  };
}

export function loadListFilters(): ListFilterState | null {
  try {
    const raw = localStorage.getItem(LIST_FILTER_KEY);
    if (!raw) return null;
    return sanitizeListFilters(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function saveListFilters(state: ListFilterState): void {
  try {
    localStorage.setItem(LIST_FILTER_KEY, JSON.stringify(state));
  } catch {
    // 筛选记忆失败不影响列表本身
  }
}

/* ------------------------------ 导出导入 ------------------------------ */

/** 导出为格式化 JSON（version 2，保留 settings.schemaVersion） */
export function exportJSON(db: DB): string {
  const payload = {
    exportedAt: new Date().toISOString(),
    app: 'jobdesk',
    version: 2,
    settings: db.settings,
    companies: db.companies,
    applications: db.applications,
    interviews: db.interviews,
    notes: db.notes,
    experiences: db.experiences,
    questions: db.questions,
    staging: db.staging,
  };
  return JSON.stringify(payload, null, 2);
}

/** 把文本按 JSON 解析后校验，用于「导入 JSON」 */
export function importFromText(text: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: '文件内容不是合法的 JSON，请确认选对了备份文件' };
  }
  return validateImport(parsed);
}

/** 给「迁移失败页」用的原始数据下载（不写任何 key） */
export function downloadRawJSON(raw: string, filename: string): boolean {
  try {
    const blob = new Blob([raw], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    return true;
  } catch {
    return false;
  }
}

/** 回滚点的 key 前缀（设置页展示用） */
export const ROLLBACK_PREFIX = BACKUP_KEY_PREFIX;

/** 读上一次迁移的指针（设置页「迁移记录」展示用） */
export const readMigrationPointer = readPointer;

/** 平台默认值（供设置页下拉用，避免各组件各写一份） */
export const DEFAULT_PLATFORM_ORDER: PlatformId[] = ['boss', 'shixiseng', 'nowcoder', 'custom'];

/** 空状态映射覆盖表的类型别名（设置页编辑用） */
export type StatusMapOverrides = Record<string, Status | null>;
