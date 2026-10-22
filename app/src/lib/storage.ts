/**
 * localStorage 持久化 + JSON 导入导出 + schema 校验分发。
 *
 * 铁律：读失败绝不允许白屏 —— 降级为空数据 + 提示「数据已损坏，可导出修复」。
 *
 * ★ 语义提醒（架构 D-05）：`validateImport` 的名字是「校验」，但它同时负责**迁移**：
 *   v1 / v2 → migrateV2ToV3（内部级联 v1→v2→v3），v3 → validateV2。启动与导入共用这一个入口，
 *   所以「v1 备份导入」与「启动时自动迁移」物理上是同一份实现，不可能漂移。
 *   版本分发上限统一由 `SCHEMA_VERSION_CURRENT` 决定，禁止再写死数字。
 */

import type { DB, PlatformId, Status } from '../types';
import type { InsightsTab } from './api';
import { BUDGET } from './budget';
import { defaultSettings, emptyDB } from './defaults';
import { FORMAT_VERSION_CURRENT, SCHEMA_VERSION_CURRENT, SCHEMA_VERSION_V1, SCHEMA_VERSION_V2, SCHEMA_VERSION_V3, migrateV2ToV3, resolveSchemaVersion } from './migrate';
import {
  BACKUP_KEY_PREFIX,
  readPointer,
  sweepRollbackPoints,
  writePointer,
  writeRollbackPoint,
} from './rollback';
import { describeWriteError, localBackend, type StorageBackend } from './storage/backend';
import { detectBackend } from './storage/detect';
import { type ImportResult, validateV2 } from './validateV2';

export { defaultSettings, emptyDB };
export type { ImportResult };

/* ------------------------- v0.5：存储后端接入 ------------------------- */

/**
 * 当前后端怎么定、什么时候定。
 *
 * 约束：启动路径（`useState(() => loadDB())`）是**同步**的，不能为了 IDB 把整个
 * App 改成 await 引导 —— 那会牵动「渲染失败页并 return」的时序，而那段时序
 * 正是 QA D4 那次数据丢失事故的现场，不能拿它换一个异步签名。
 *
 * 所以：
 * - `file://`  → localStorage，模块加载时直接定（同步、可预测、就是主场景）
 * - `https://` → localStorage（第三方平台托管，容量本就宽松，不值得引入 IDB 的复杂度）
 * - `http://`  → IndexedDB（本地开发 / 自建服务器），这是唯一允许异步的分支
 *
 * 注意 http 下首个同步读会返回「读取中」，由 `whenReady()` 之后的重新加载补上。
 * 这个窗口只有几十毫秒，且**闸门是锁着的**，绝不会有东西被覆盖。
 */
let backendPinned: StorageBackend | null = null;
let backendReady: Promise<void> = Promise.resolve();

export function activeBackend(): StorageBackend {
  if (backendPinned) return backendPinned;
  return localBackend;
}

export function activeBackendName(): string {
  return activeBackend().name;
}

/** 后端就绪（http 下的 IDB 探测完成后 resolve）；其它情况立刻 resolve */
export function whenBackendReady(): Promise<void> {
  return backendReady;
}

/**
 * 同步读：只对 localStorage 成立。IDB 下返回 `pending`，
 * 由调用方决定「先当空的、就绪后重读」—— 见 App 的 boot 逻辑。
 */
type SyncRead =
  | { status: 'ok'; value: string }
  | { status: 'empty' }
  | { status: 'error'; message: string }
  | { status: 'pending' };

function readSync(backend: StorageBackend, key: string): SyncRead {
  if (backend.name !== 'localStorage') return { status: 'pending' };
  try {
    const value = localStorage.getItem(key);
    return value === null ? { status: 'empty' } : { status: 'ok', value };
  } catch {
    return { status: 'error', message: '浏览器禁止了本地存储，数据无法读取。请检查隐私设置。' };
  }
}

/**
 * 模块加载即定后端。同步分支（file:// / https）在这里就落地；
 * 只有 http 会进入异步探测，并在完成后把 `backendPinned` 换掉。
 */
function bootBackend(): void {
  const protocol = typeof location === 'undefined' ? '' : location.protocol;
  if (protocol !== 'http:') {
    // file:// 与 https:// 都用 localStorage：前者是 IDB 本来就不支持，
    // 后者是托管平台的配额够用，没必要为省容量引入异步引导。
    backendPinned = localBackend;
    backendReady = Promise.resolve();
    return;
  }
  backendReady = detectBackend().then((result) => {
    backendPinned = result.backend;
  });
}

bootBackend();

/** 供 App 在探测完成后判断「要不要因为换了后端而重读一次」 */
export function isBackendPending(): boolean {
  return backendPinned === null;
}

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
 *
 * ★ v0.6：分发上限改由 `SCHEMA_VERSION_CURRENT` 决定，不再写死 2。
 *   v1 / v2 都走 `migrateV2ToV3`（内部级联 v1→v2→v3），
 *   保证「启动迁移」与「导入备份」物理上是同一份实现，不可能漂移。
 */
export function validateImport(raw: unknown): ImportResult {
  if (!isRecord(raw)) return { ok: false, error: '顶层不是一个对象' };
  if (!('settings' in raw) && !('applications' in raw)) {
    return { ok: false, error: '缺少 settings / applications 字段，这不像是本应用导出的备份' };
  }

  const version = resolveSchemaVersion(raw);
  if (version === SCHEMA_VERSION_CURRENT) return validateV2(raw);
  // v0.8：v3（v0.6~v0.7.x 的备份）也走同一条迁移链 —— migrateV2ToV3 内部对 v3
  // 直接级联 migrateV3ToV4，保证「启动迁移」与「导入备份」永远是同一份实现。
  if (
    version === SCHEMA_VERSION_V1 ||
    version === SCHEMA_VERSION_V2 ||
    version === SCHEMA_VERSION_V3 ||
    version === 'unknown'
  ) {
    // §D.3：v1 / v2 / v3 备份导入必须成功，且走同一条迁移
    const migrated = migrateV2ToV3(raw, { now: new Date().toISOString() });
    if (!migrated.ok) return { ok: false, error: migrated.error };
    // 迁移产物过一遍校验，避免「迁移写出一个自己都读不回来的库」
    return validateV2(migrated.db);
  }
  return {
    ok: false,
    error:
      version > SCHEMA_VERSION_CURRENT
        ? `这份备份来自 v${version} 数据格式的新版本，请先升级工具再导入（当前支持到 ${SCHEMA_VERSION_CURRENT}）`
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

  // v0.5：主数据走「当前后端」（localStorage 或 IndexedDB）。
  // 这一层之上的一切（校验、迁移、坏数据隔离、上锁）与 v0.4.1 完全相同 ——
  // 后端只负责「把字符串拿给我」，不参与任何业务判断。
  const backend = activeBackend();
  const outcome = readSync(backend, STORAGE_KEY);
  if (outcome.status === 'empty') return { db: emptyDB(), error: null };
  if (outcome.status === 'error') {
    // 读不出来的原因可能是后端不可用（而不是数据坏了）：
    // 这时绝不能当「空库」继续写，否则一次渲染就把用户数据覆盖掉（QA D4 的老坑）。
    return {
      db: emptyDB(),
      error: outcome.message,
      migration: {
        failed: true,
        from: 1,
        backupKey: null,
        failedAtKey: null,
        raw: '',
        reason: outcome.message,
      },
    };
  }
  if (outcome.status === 'pending') {
    // http 下 IDB 还没探测完。返回空库，但在调用方（App）进入主界面之前
    // 必须等 `whenBackendReady()` 并重新 loadDBAsync 一次。
    return { db: emptyDB(), error: null };
  }
  return readDBFromRaw(outcome.value);
}

/**
 * 从「已拿到的原始字符串」走完校验 / 迁移 / 坏数据隔离。
 *
 * ★ 这是 v0.5 抽出来的：后端换成 IndexedDB 后，读出来的是一段字符串，
 *   字符串之后的一切必须与 localStorage 路径**完全同一条代码**，
 *   否则「同一个备份，file:// 打开能读、http 打开读不出」这种鬼故事就会发生。
 */
function readDBFromRaw(raw: string): LoadResult {
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

  // 已经是当前版本：直接校验
  if (version === SCHEMA_VERSION_CURRENT) {
    const result = validateV2(parsed);
    if (result.ok) return { db: result.db, error: null };
    const failedAtKey = preserveFailedRaw(raw, new Date().toISOString());
    return {
      db: emptyDB(),
      error: `数据已损坏（${result.error}），可下载原始数据后修复。已临时降级为空数据。`,
      migration: {
        failed: true,
        from: SCHEMA_VERSION_CURRENT,
        backupKey: null,
        failedAtKey,
        raw,
        reason: result.error,
      },
    };
  }

  if (typeof version === 'number' && version > SCHEMA_VERSION_CURRENT) {
    const failedAtKey = preserveFailedRaw(raw, new Date().toISOString());
    return {
      db: emptyDB(),
      error: `数据来自更新版本（v${version}），当前工具最高支持 v${SCHEMA_VERSION_CURRENT}。`,
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

  /* ---------- v1 / v2 / unknown：先备份，再逐级迁移到当前版本 ---------- */
  const fromVersion = version === 'unknown' ? SCHEMA_VERSION_V1 : version;
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
        from: fromVersion,
        backupKey: null,
        failedAtKey,
        raw,
        reason: `${backup.error}。为了避免在没有退路的情况下改数据，迁移已中止`,
      },
    };
  }

  const migrated = migrateV2ToV3(parsed, { now: nowIso });
  if (!migrated.ok) {
    writePointer({ from: fromVersion, to: SCHEMA_VERSION_CURRENT, at: nowIso, backupKey: backup.key, status: 'failed', reason: migrated.error });
    return {
      db: emptyDB(),
      error: `迁移失败：${migrated.error}。原数据没有被改动，回滚点已保留。`,
      migration: { failed: true, from: fromVersion, backupKey: backup.key, failedAtKey: backup.key, raw, reason: migrated.error },
    };
  }

  const verified = validateV2(migrated.db);
  if (!verified.ok) {
    writePointer({ from: fromVersion, to: SCHEMA_VERSION_CURRENT, at: nowIso, backupKey: backup.key, status: 'failed', reason: verified.error });
    return {
      db: emptyDB(),
      error: `迁移结果校验失败：${verified.error}。原数据没有被改动，回滚点已保留。`,
      migration: { failed: true, from: fromVersion, backupKey: backup.key, failedAtKey: backup.key, raw, reason: verified.error },
    };
  }

  const db = verified.db;
  db.settings.lastMigration = { from: fromVersion, to: SCHEMA_VERSION_CURRENT, at: nowIso, backupKey: backup.key };
  const writeError = writeDB(db);
  if (writeError) {
    // 写不进去也不能白屏：把数据交出去，让用户先导出
    return {
      db,
      error: `${writeError} 迁移结果已在内存中，请立刻导出备份。`,
    };
  }
  writePointer({ from: fromVersion, to: SCHEMA_VERSION_CURRENT, at: nowIso, backupKey: backup.key, status: 'done' });
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
  // ★ v0.5：体积上限只在 localStorage 后端生效。
  //   IndexedDB 的配额是磁盘百分比（几百 MB 起步），4.5MB 这个数字是为
  //   localStorage 的 5MB 天花板留的余量，套到 IDB 上会让「大库」这个
  //   唯一卖点当场失效。IDB 下改为配额预检（见 checkQuota）。
  const backend = activeBackend();
  if (backend.name === 'localStorage' && size >= BUDGET.block) {
    return `数据已达约 ${Math.round(size / 10000) / 100} 万字符，超过安全上限，已暂停写入。请先导出备份，再清理一批已结束的投递。`;
  }
  if (backend.name === 'localStorage') {
    try {
      localStorage.setItem(STORAGE_KEY, text);
      return null;
    } catch (error) {
      const failure = describeWriteError(error);
      // ★ 配额满 = 继续接受编辑只会造成「改了却没存上」的静默丢失 ——
      //   这里触发只读锁定（与读失败同一条闸门），出口只有导出备份。
      if (failure.quotaExceeded) lockPersistence();
      return failure.message;
    }
  }

  // IndexedDB：写入是异步的，但 saveDB 的签名必须保持 sync（调用方是 useEffect，
  // 且要能立刻拿到错误串去展示）。做法是「排队 + 只保留最新一版」：
  // 连续 mutate 三次只落盘最后一版，中途的中间态没有保存价值。
  queueIDBWrite(backend, text);
  return null;
}

/* ---------------------- IndexedDB 写队列（只留最新一版） ---------------------- */

let writeChain: Promise<void> = Promise.resolve();
let queued: { backend: StorageBackend; text: string } | null = null;
let lastWriteError: string | null = null;
const writeErrorListeners = new Set<(message: string | null) => void>();

/** 订阅 IDB 异步写失败（同步签名拿不到，只能事后通知） */
export function onAsyncWriteError(listener: (message: string | null) => void): () => void {
  writeErrorListeners.add(listener);
  return () => writeErrorListeners.delete(listener);
}

/** 最近一次异步写失败的原因；成功后清空 */
export function getAsyncWriteError(): string | null {
  return lastWriteError;
}

function reportWriteError(message: string | null): void {
  if (lastWriteError === message) return;
  lastWriteError = message;
  for (const listener of writeErrorListeners) listener(message);
}

function queueIDBWrite(backend: StorageBackend, text: string): void {
  queued = { backend, text };
  writeChain = writeChain.then(async () => {
    const job = queued;
    if (!job) return;
    queued = null; // 先清再写：写入期间新的写入会重新排队，不会丢
    const failure = await job.backend.write(STORAGE_KEY, job.text);
    if (failure) {
      // IndexedDB 配额满同样锁只读：静默丢写入比报错更危险
      if (failure.quotaExceeded) lockPersistence();
      reportWriteError(failure.message);
    } else {
      reportWriteError(null);
    }
  });
}

/** 测试与「导出前」用：等所有排队中的写入落盘 */
export async function flushWrites(): Promise<void> {
  await writeChain;
}

/**
 * 异步版启动读取（v0.5）。
 *
 * 为什么需要两个入口：`loadDB()` 是同步的、给 localStorage 后端和既有测试用；
 * http 下后端是 IndexedDB，同步读拿不到东西 —— 这时**必须 await 这个**，
 * 绝不能把同步结果的空库当成真数据进主界面（那就是 485 字节事故的翻版）。
 */
export async function loadDBAsync(): Promise<LoadResult> {
  await whenBackendReady();
  const backend = activeBackend();
  if (backend.name === 'localStorage') return loadDB();

  const outcome = await backend.read(STORAGE_KEY);
  if (outcome.status === 'error') {
    const result: LoadResult = {
      db: emptyDB(),
      error: outcome.message,
      migration: {
        failed: true,
        from: 1,
        backupKey: null,
        failedAtKey: null,
        raw: '',
        reason: outcome.message,
      },
    };
    lockPersistence();
    return result;
  }
  const result =
    outcome.status === 'empty' ? { db: emptyDB(), error: null } : readDBFromRaw(outcome.value);
  if (result.migration?.failed) lockPersistence();
  return result;
}

/** 配额预检（v0.5）：剩余 < 10% 时提醒用户导出归档 */
export async function checkQuota(): Promise<{ usage: number; quota: number; ratio: number } | null> {
  const estimate = await activeBackend().estimate();
  if (!estimate || estimate.quota <= 0) return null;
  return { ...estimate, ratio: estimate.usage / estimate.quota };
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
  let raw: string | null;
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

/**
 * 导出为格式化 JSON（formatVersion 3，settings.schemaVersion 原样保留）。
 *
 * v0.6：`formatVersion` 改用常量 `FORMAT_VERSION_CURRENT`，与内部 schemaVersion
 * 彻底解耦 —— 内部结构升到 v4，导出格式跟到 3（老版本的备份带更小的 schemaVersion，
 * 会按「旧格式走迁移」读入；新版本备份则按「更新版本」拒绝而不是读坏）。
 *
 * v0.8：pluginStorage / aiSuggestions 随导出（可往返）；
 * **requestLog 剥离**（PRD 验收 13：导出 JSON 默认不含请求日志 —— 审计数据只留在本机）。
 */
export function exportJSON(db: DB): string {
  const payload = {
    exportedAt: new Date().toISOString(),
    app: 'jobdesk',
    formatVersion: FORMAT_VERSION_CURRENT,
    version: db.settings.schemaVersion,
    settings: db.settings,
    companies: db.companies,
    applications: db.applications,
    interviews: db.interviews,
    notes: db.notes,
    experiences: db.experiences,
    questions: db.questions,
    staging: db.staging,
    events: db.events,
    pluginStorage: db.pluginStorage,
    aiSuggestions: db.aiSuggestions,
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

/* ------------------------------ 备份时间与回滚点 ------------------------------ */

const LAST_EXPORT_KEY = 'jobdesk.v1.lastExportAt';

/** 记录「刚刚导出过」的时间（只用于设置页提示，不参与任何业务判断） */
export function markExported(nowIso: string = new Date().toISOString()): void {
  try {
    localStorage.setItem(LAST_EXPORT_KEY, nowIso);
  } catch {
    // 记不住就算了，不能因为记时间失败而让导出失败
  }
}

export function getLastExportAt(): string | null {
  try {
    return localStorage.getItem(LAST_EXPORT_KEY);
  } catch {
    return null;
  }
}

/**
 * 清理迁移回滚点（`jobdesk.v1.preMigrate.*`），返回释放的 key 数与字节数。
 *
 * 只清回滚点，**绝不动** `failedAt.*` —— 那些是读不出来的坏数据的唯一副本，
 * 用户可能正要靠它救命。清理动作永远由用户在设置页显式触发。
 */
export function purgeRollbackPoints(): { keys: number; bytes: number } {
  let keys = 0;
  let bytes = 0;
  for (const key of listKeysWithPrefix(BACKUP_KEY_PREFIX)) {
    try {
      const value = localStorage.getItem(key);
      if (value !== null) bytes += key.length + value.length;
      localStorage.removeItem(key);
      keys += 1;
    } catch {
      // 单个 key 失败不影响其它 key
    }
  }
  return { keys, bytes };
}

/** 回滚点占用的总字符数（设置页展示用） */
export function rollbackPointsSize(): number {
  let bytes = 0;
  for (const key of listKeysWithPrefix(BACKUP_KEY_PREFIX)) {
    try {
      const value = localStorage.getItem(key);
      if (value !== null) bytes += key.length + value.length;
    } catch {
      // 读不到就不计
    }
  }
  return bytes;
}

/** 回滚点的 key 前缀（设置页展示用） */
export const ROLLBACK_PREFIX = BACKUP_KEY_PREFIX;

/** 读上一次迁移的指针（设置页「迁移记录」展示用） */
export const readMigrationPointer = readPointer;

/** 平台默认值（供设置页下拉用，避免各组件各写一份） */
export const DEFAULT_PLATFORM_ORDER: PlatformId[] = ['boss', 'shixiseng', 'nowcoder', 'liepin', 'custom'];

/** 空状态映射覆盖表的类型别名（设置页编辑用） */
export type StatusMapOverrides = Record<string, Status | null>;
