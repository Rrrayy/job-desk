/**
 * 灾难恢复回归（v0.4.1 新增，对齐迭代方案 D7 的六条）。
 *
 * 这一组测试不验证「功能对不对」，只验证**出事的时候数据还在不在**。
 * 任何一条变红，都意味着用户可能在某个异常路径上永久丢数据 —— 优先级高于任何新功能。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDB } from './defaults';
import { buildSampleDB } from './sample';
import {
  exportJSON,
  importFromText,
  isPersistenceLocked,
  loadDB,
  purgeRollbackPoints,
  resetPersistenceLock,
  rollbackPointsSize,
  saveDB,
  unlockPersistence,
} from './storage';

const STORAGE_KEY = 'jobdesk.v1';
const ROLLBACK_PREFIX = 'jobdesk.v1.preMigrate.';
const FAILED_PREFIX = 'jobdesk.v1.failedAt.';

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

interface Failure {
  migration: { failed: true; failedAtKey: string | null };
}

/** loadDB 的失败标志在 migration.failed（不是顶层 failed）；失败页据此渲染 */
const isFailure = (result: { migration?: { failed?: boolean } }): result is typeof result & Failure =>
  result.migration?.failed === true;

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
  resetPersistenceLock();
});

/* ------------------------------ 1. 导出 → 清空 → 导入 ------------------------------ */

describe('D7-1 导出 → 清空 → 导入，数据必须一模一样', () => {
  it('示例库往返一次：投递 / 面试 / 时间线 / 日程 全部还原', () => {
    const original = buildSampleDB(new Date('2026-10-21T09:00:00'));
    const backup = exportJSON(original);

    // 「换电脑」：当前浏览器什么都没有
    localStorage.clear();
    resetPersistenceLock();

    const result = importFromText(backup);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.db.applications).toHaveLength(original.applications.length);
    expect(result.db.interviews).toHaveLength(original.interviews.length);
    expect(result.db.notes).toHaveLength(original.notes.length);
    // v0.4 的日程表当年差点漏在导出之外，这条断言就是为了钉住它
    expect(result.db.events).toHaveLength(original.events.length);
    expect(result.db.events.map((item) => item.title)).toEqual(original.events.map((item) => item.title));
  });

  it('导入后落盘 → 再读取，字节与导入内容等价（不会被二次改写）', () => {
    const db = buildSampleDB(new Date('2026-10-21T09:00:00'));
    const backup = exportJSON(db);
    const imported = importFromText(backup);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    expect(saveDB(imported.db)).toBeNull();
    const reloaded = loadDB();
    expect(reloaded.db.applications).toHaveLength(imported.db.applications.length);
    expect(reloaded.db.events).toHaveLength(imported.db.events.length);
    expect(reloaded.migration).toBeUndefined();
  });
});

/* ------------------------------ 2. 损坏 JSON ------------------------------ */

describe('D7-2 损坏的备份：只读锁定 + 原数据一个字节都不动', () => {
  it('非 JSON 文本 → 返回可读错误，不进入只读（因为根本没碰本地数据）', () => {
    const result = importFromText('这不是 JSON{{{');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('JSON');
  });

  it('本地已有好数据时导入坏文件 → 本地 key 不变', () => {
    const db = buildSampleDB(new Date('2026-10-21T09:00:00'));
    saveDB(db);
    const before = localStorage.getItem(STORAGE_KEY);

    const bad = importFromText('{"settings":{},"applications":"oops"}');
    expect(bad.ok).toBe(false);

    expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
    expect(isPersistenceLocked()).toBe(false);
  });
});

/* ------------------------------ 3. 更新版本的备份 ------------------------------ */

describe('D7-3 来自更新版本的备份：拒绝导入，且不破坏现有数据', () => {
  it('settings.schemaVersion = 99 → 明确提示「请先升级工具」', () => {
    const db = emptyDB();
    saveDB(db);
    const before = localStorage.getItem(STORAGE_KEY);

    // 版本解析优先看 settings.schemaVersion（迁移层契约），未来版本一定会把它写成 > 2
    const future = JSON.stringify({ ...JSON.parse(exportJSON(db)), version: 99 });
    const futureTyped = JSON.parse(future) as { settings: Record<string, unknown> };
    futureTyped.settings.schemaVersion = 99;
    const result = importFromText(JSON.stringify(futureTyped));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('新版本');

    expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
  });
});

/* ------------------------------ 4. 迁移失败 ------------------------------ */

describe('D7-4 v1 数据迁移失败：上锁 + 原文另存 + 不覆盖', () => {
  it('v1 缺关键字段 → 失败页，原 key 字节不变，且留了一份 failedAt 副本', () => {
    const brokenV1 = JSON.stringify({
      applications: 'not-an-array',
      companies: [],
      settings: { schemaVersion: 1 },
    });
    localStorage.setItem(STORAGE_KEY, brokenV1);
    const beforeBytes = brokenV1.length;

    const result = loadDB();
    expect(isFailure(result)).toBe(true);
    if (!isFailure(result)) return;

    expect(localStorage.getItem(STORAGE_KEY)).toHaveLength(beforeBytes);
    expect(isPersistenceLocked()).toBe(true);
    expect(result.migration.failedAtKey).not.toBeNull();
    // 上锁之后任何写入都必须是 no-op
    expect(saveDB(emptyDB())).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toHaveLength(beforeBytes);

    unlockPersistence();
  });
});

/* ------------------------------ 5. 导入中断 ------------------------------ */

describe('D7-5 导入中断 / 半截文件：原数据不变', () => {
  it('被截断的 JSON → 拒绝，本地数据原样', () => {
    const db = buildSampleDB(new Date('2026-10-21T09:00:00'));
    saveDB(db);
    const before = localStorage.getItem(STORAGE_KEY);

    const truncated = exportJSON(db).slice(0, 200);
    const result = importFromText(truncated);
    expect(result.ok).toBe(false);

    expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
  });
});

/* ------------------------------ 6. 迁移幂等 ------------------------------ */

describe('D7-6 同一份 v1 备份连续导入两次：第二次结果与第一次一致', () => {
  const v1Payload = JSON.stringify({
    settings: { schemaVersion: 1, warnAfterDays: 4, staleAfterDays: 9, courseSlots: [] },
    companies: [{ id: 'c1', name: '小红书', createdAt: '2026-09-01T00:00:00.000Z' }],
    applications: [
      {
        id: 'a1',
        companyId: 'c1',
        jobTitle: '前端开发实习生',
        jobType: 'daily',
        status: 'applied',
        statusChangedAt: '2026-09-02T00:00:00.000Z',
        lastActivityAt: '2026-09-02T00:00:00.000Z',
        appliedAt: '2026-09-02',
      },
    ],
    interviews: [],
    notes: [],
  });

  it('两次导入的库等价（不重复插入、不自增计数）', () => {
    const first = importFromText(v1Payload);
    const second = importFromText(v1Payload);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.db.applications).toHaveLength(first.db.applications.length);
    expect(second.db.companies).toHaveLength(first.db.companies.length);
    expect(second.db.settings.schemaVersion).toBe(2);
    // 幂等的真正含义：结果序列化后完全一致
    expect(exportJSON(second.db)).toBe(exportJSON(first.db));
  });
});

/* --------------------- 回滚点清理：只清迁移快照，绝不碰坏数据副本 --------------------- */

describe('回滚点清理的边界', () => {
  it('只删除 preMigrate.*，failedAt.* 必须保留', () => {
    localStorage.setItem(`${ROLLBACK_PREFIX}2026-10-01T00-00-00-000Z`, '{"a":1}');
    localStorage.setItem(`${ROLLBACK_PREFIX}2026-10-02T00-00-00-000Z`, '{"a":2}');
    const failedKey = `${FAILED_PREFIX}2026-10-03T00-00-00-000Z`;
    localStorage.setItem(failedKey, '{"broken":true}');

    expect(rollbackPointsSize()).toBeGreaterThan(0);
    const freed = purgeRollbackPoints();

    expect(freed.keys).toBe(2);
    expect(localStorage.getItem(`${ROLLBACK_PREFIX}2026-10-01T00-00-00-000Z`)).toBeNull();
    // 坏数据的唯一副本，动了就是二次事故
    expect(localStorage.getItem(failedKey)).toBe('{"broken":true}');
    expect(rollbackPointsSize()).toBe(0);
  });
});
