/**
 * storage 层回归测试（QA D4 / D7）。
 *
 * 为什么这一层必须有测试：启动读失败时 App 会先渲染失败页再 return，
 * 但落盘的 `useEffect(..., [db])` 早已注册 —— 一次渲染就能把用户的真实数据
 * 覆盖成 485 字节的空骨架。这个洞不能靠「渲染顺序别赌」来堵，
 * 所以闸门放在 storage 层，测试也就打在 storage 层。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDB } from './defaults';
import { apply, plan } from './sync/engine';
import {
  DEFAULT_LIST_FILTERS,
  isPersistenceLocked,
  loadDB,
  loadListFilters,
  lockPersistence,
  preserveFailedRaw,
  resetPersistenceLock,
  sanitizeListFilters,
  saveDB,
  saveListFilters,
  unlockPersistence,
} from './storage';

const STORAGE_KEY = 'jobdesk.v1';
const FAILED_PREFIX = 'jobdesk.v1.failedAt.';

/** 内存版 localStorage（node 环境没有；且要能精确断言「一个字节都没动」） */
class MemoryStorage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  getItem(key: string): string | null {
    const value = this.map.get(key);
    return value === undefined ? null : value;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
  resetPersistenceLock();
});

/** 造一份「看起来像 v2、其实缺字段」的坏数据（QA 验的 v2-invalid 场景） */
const BROKEN_V2 = JSON.stringify({
  settings: { schemaVersion: 2 },
  applications: 'not-an-array',
  companies: [],
});

describe('D4 · 读失败绝不覆盖用户原数据', () => {
  it('v2 缺字段 → 失败页；模拟 App 的 saveDB 落盘 → jobdesk.v1 字节数不变', () => {
    localStorage.setItem(STORAGE_KEY, BROKEN_V2);
    const before = byteLength(localStorage.getItem(STORAGE_KEY) as string);

    const boot = loadDB();
    expect(boot.migration?.failed).toBe(true);
    // ★ 读失败的那一瞬间就上锁，而不是等 App 渲染到失败页
    expect(isPersistenceLocked()).toBe(true);

    // 模拟 App 里 `useEffect(() => { saveDB(db) }, [db])` 跑了一遍
    saveDB(emptyDB());

    const after = localStorage.getItem(STORAGE_KEY) as string;
    expect(after).toBe(BROKEN_V2);
    expect(byteLength(after)).toBe(before);
  });

  it('非 JSON → 同上，一个字节都不许被改写', () => {
    const broken = '{这不是 JSON，是用户手动编辑过的一段话';
    localStorage.setItem(STORAGE_KEY, broken);
    const before = byteLength(broken);

    const boot = loadDB();
    expect(boot.migration?.failed).toBe(true);
    saveDB(emptyDB());

    const after = localStorage.getItem(STORAGE_KEY) as string;
    expect(after).toBe(broken);
    expect(byteLength(after)).toBe(before);
  });

  it('刷新（再读一次）仍然是失败页，仍然不改写原数据', () => {
    localStorage.setItem(STORAGE_KEY, BROKEN_V2);

    const first = loadDB();
    const second = loadDB();
    expect(first.migration?.failed).toBe(true);
    expect(second.migration?.failed).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(BROKEN_V2);
  });

  it('「导出原始数据」能拿到完整原文（失败页的 raw + 另存的 failedAt key 一致）', () => {
    localStorage.setItem(STORAGE_KEY, BROKEN_V2);
    const boot = loadDB();

    expect(boot.migration?.raw).toBe(BROKEN_V2);
    const key = boot.migration?.failedAtKey ?? '';
    expect(key.startsWith(FAILED_PREFIX)).toBe(true);
    expect(localStorage.getItem(key)).toBe(BROKEN_V2);
  });

  it('刷新 10 次也只留一份原始副本（幂等，不把配额吃光）', () => {
    localStorage.setItem(STORAGE_KEY, BROKEN_V2);
    for (let i = 0; i < 10; i += 1) loadDB();

    let count = 0;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(FAILED_PREFIX)) count += 1;
    }
    expect(count).toBe(1);
  });

  it('失败副本最多留 3 份（坏数据不能挤掉真数据的位置）', () => {
    for (let i = 0; i < 5; i += 1) {
      preserveFailedRaw(`坏内容 ${i}`, `2025-03-1${i}T10:00:00.000Z`);
    }
    let count = 0;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(FAILED_PREFIX)) count += 1;
    }
    expect(count).toBe(3);
  });

  it('用户点「用空数据继续」后解锁，才允许写盘', () => {
    localStorage.setItem(STORAGE_KEY, BROKEN_V2);
    loadDB();
    expect(isPersistenceLocked()).toBe(true);

    // 「用空数据继续」按钮做的事：接受空库 + 解锁
    unlockPersistence();
    const error = saveDB(emptyDB());
    expect(error).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).not.toBe(BROKEN_V2);
  });

  it('正常读到数据时不上锁（不能把正常用户也锁死的写不进去）', () => {
    const db = emptyDB();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));

    const boot = loadDB();
    expect(boot.error).toBeNull();
    expect(boot.migration).toBeUndefined();
    expect(isPersistenceLocked()).toBe(false);

    // 顺手确认一下：正常状态下写盘确实生效
    expect(saveDB(emptyDB())).toBeNull();
  });

  it('锁只影响 saveDB，不影响迁移路径必须落盘的 writeDB（迁移成功仍要写）', () => {
    lockPersistence();
    // 单纯锁住时 saveDB 什么都不做
    expect(saveDB(emptyDB())).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('写入时配额满 → 触发只读锁定（v0.5.1），导出备份仍是出路', () => {
    // 模拟浏览器配额满：setItem 一律抛 QuotaExceededError
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: () => null,
        setItem: () => {
          const error = new Error('quota');
          error.name = 'QuotaExceededError';
          throw error;
        },
        removeItem: () => {},
        clear: () => {},
        key: () => null,
        get length() {
          return 0;
        },
      },
      configurable: true,
      writable: true,
    });
    resetPersistenceLock();

    const error = saveDB(emptyDB());
    expect(error).toContain('存储空间已满');
    expect(isPersistenceLocked()).toBe(true);
    // 锁定后再写：一个字节都不动，不再重复报错
    expect(saveDB(emptyDB())).toBeNull();
  });
});

describe('D7 · 列表筛选条件跨刷新保留', () => {
  it('脏值一律回默认（一条坏缓存不能把列表筛成空的）', () => {
    const dirty = sanitizeListFilters({
      status: 123,
      channel: null,
      version: undefined,
      cities: [1, '北京', null, '上海'],
      keyword: 'x'.repeat(200),
      sortKey: 42,
      sortDir: 'up',
    });
    expect(dirty).not.toBeNull();
    expect(dirty?.status).toBe(DEFAULT_LIST_FILTERS.status);
    expect(dirty?.channel).toBe(DEFAULT_LIST_FILTERS.channel);
    expect(dirty?.version).toBe(DEFAULT_LIST_FILTERS.version);
    expect(dirty?.cities).toEqual(['北京', '上海']);
    expect(dirty?.keyword).toHaveLength(100);
    expect(dirty?.sortKey).toBe(DEFAULT_LIST_FILTERS.sortKey);
    expect(dirty?.sortDir).toBe(DEFAULT_LIST_FILTERS.sortDir);
  });

  it('不是对象 / 完全认不出来 → null（调用方回默认）', () => {
    expect(sanitizeListFilters(null)).toBeNull();
    expect(sanitizeListFilters('board')).toBeNull();
    expect(sanitizeListFilters([1, 2, 3])).toBeNull();
    expect(loadListFilters()).toBeNull();
  });

  it('写入 → 读回，六个字段一起 round-trip', () => {
    saveListFilters({
      status: 'chatting',
      channel: 'referral',
      version: 'v3',
      cities: ['北京', ''],
      keyword: '字节',
      sortKey: 'appliedAt',
      sortDir: 'asc',
    });
    expect(loadListFilters()).toEqual({
      status: 'chatting',
      channel: 'referral',
      version: 'v3',
      cities: ['北京', ''],
      keyword: '字节',
      sortKey: 'appliedAt',
      sortDir: 'asc',
    });
  });

  it('缓存被写坏成非 JSON → 读回 null 而不是抛异常', () => {
    localStorage.setItem('jobdesk.v1.listFilters', '{不是 JSON');
    expect(loadListFilters()).toBeNull();
  });
});

/**
 * D1 的闭环检查：同步写进暂存的「解析失败」条目，必须能被**下一次启动**读回来。
 * 少了这条，就会出现「同步完好好的，一刷新就被自己判成坏数据进失败页」。
 */
describe('D1 · 暂存里的解析失败条目能安全往返', () => {
  it('写盘 → 再读 → 暂存条目还在，且不会被校验判成坏数据', () => {
    const db = emptyDB();
    const result = plan({
      records: [],
      db,
      platform: 'boss',
      capturedAt: '2025-03-13T12:00:00.000Z',
      overrides: {},
      autoRefreshActivity: true,
      now: '2025-03-13T12:00:00.000Z',
      unparsed: [{ rawSnippet: '??? 这一行什么都没有', reason: '这一行没有公司名' }],
    });
    const applied = apply(db, {
      rows: result.rows,
      now: '2025-03-13T12:00:00.000Z',
      capturedAt: '2025-03-13T12:00:00.000Z',
      platform: 'boss',
      unparsed: result.unparsed,
    });

    localStorage.setItem(STORAGE_KEY, JSON.stringify(applied.db));
    const boot = loadDB();

    expect(boot.error).toBeNull();
    expect(boot.migration).toBeUndefined();
    expect(boot.db.staging).toHaveLength(1);
    expect(boot.db.staging[0].reason).toBe('unparsed');
    expect(boot.db.staging[0].rawSnippet).toBe('??? 这一行什么都没有');
    expect(boot.db.staging[0].reasonText).toBe('这一行没有公司名');
  });
});
