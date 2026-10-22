/**
 * 灾难恢复回归（v0.4.1 新增，对齐迭代方案 D7 的六条）。
 *
 * 这一组测试不验证「功能对不对」，只验证**出事的时候数据还在不在**。
 * 任何一条变红，都意味着用户可能在某个异常路径上永久丢数据 —— 优先级高于任何新功能。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDB } from './defaults';
import { SCHEMA_VERSION_CURRENT } from './migrate';
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
    // exportJSON 会打上毫秒级 exportedAt：两次真实调用一旦跨毫秒，
    // 序列化结果必然不同（CI 曾因此在 node 18 / node 20 各随机挂过一次）。
    // 固定时钟，让「等价」只由库状态决定 —— 这才是幂等要证明的东西。
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'));
    try {
      const first = importFromText(v1Payload);
      const second = importFromText(v1Payload);
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;

      expect(second.db.applications).toHaveLength(first.db.applications.length);
      expect(second.db.companies).toHaveLength(first.db.companies.length);
      expect(second.db.settings.schemaVersion).toBe(SCHEMA_VERSION_CURRENT);
      // 幂等的真正含义：结果序列化后完全一致
      expect(exportJSON(second.db)).toBe(exportJSON(first.db));
    } finally {
      vi.useRealTimers();
    }
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

/* ====================== v0.8：schema 3→4 迁移的安全三出口 ====================== */

describe('v0.8 迁移（3→4）：v0.7.3 备份导入零损失', () => {
  /** 一份 v0.7.3 形状的真实备份（无插件三表 / settings.ai / written / kind） */
  const v073Backup = JSON.stringify({
    exportedAt: '2026-10-01T00:00:00.000Z',
    app: 'jobdesk',
    formatVersion: 2,
    version: 3,
    settings: {
      schemaVersion: 3,
      warnAfterDays: 3, staleAfterDays: 7, interviewResultWaitDays: 5, wishlistExpireDays: 7,
      resultPromptHour: 20, offerSilenceDays: 7, deadlineWarnDays: 3, dailyActionBudget: 5,
      channelFactor: { referral: 3, official: 2, boss: 1, shixiseng: 1, nowcoder: 1, liepin: 1, other: 1 },
      weeklyApplyGoal: 8, courseSlots: [], defaultResumeVersion: '',
      backupReminderDays: 7, fileLink: { enabled: false, readOnly: false }, encryption: { enabled: false },
      sync: { defaultPlatform: 'boss', statusMapOverrides: {}, autoRefreshActivity: true },
    },
    companies: [{ id: 'c1', name: '字节跳动', shortName: '字节', createdAt: '2026-09-01T00:00:00.000Z' }],
    applications: [{
      id: 'a1', companyId: 'c1', jobTitle: '前端开发实习生', jobType: 'daily', status: 'chatting',
      statusChangedAt: '2026-09-02T00:00:00.000Z', lastActivityAt: '2026-09-02T00:00:00.000Z',
      appliedAt: '2026-09-02', createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
      rejectedAtRound: null, silenceOverride: null, nextActionAt: null, deadlineAt: null, mutedUntil: null, tags: [],
    }],
    interviews: [{
      id: 'iv1', applicationId: 'a1', round: 1, totalRounds: null,
      scheduledAt: '2026-09-08T14:00:00.000Z', format: 'video', result: 'pending', prepChecklist: [],
    }],
    notes: [], experiences: [], questions: [], staging: [], events: [],
  });

  it('★ 导入零错误零损失：原有数组逐条等价，插件三表为空', () => {
    const result = importFromText(v073Backup);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(v073Backup) as { applications: unknown[]; interviews: unknown[]; companies: unknown[] };
    expect(result.db.applications).toHaveLength(parsed.applications.length);
    expect(result.db.applications[0]).toEqual(parsed.applications[0]);
    expect(result.db.interviews).toEqual(parsed.interviews);
    expect(result.db.companies).toEqual(parsed.companies);
    expect(result.db.pluginStorage).toEqual([]);
    expect(result.db.requestLog).toEqual([]);
    expect(result.db.aiSuggestions).toEqual([]);
    expect(result.db.settings.schemaVersion).toBe(SCHEMA_VERSION_CURRENT);
  });

  it('★ 迁移前回滚点存在且内容 = 原始字节（启动路径）', () => {
    localStorage.setItem(STORAGE_KEY, v073Backup);
    const result = loadDB();
    expect(result.migration).toBeUndefined();

    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(ROLLBACK_PREFIX)) keys.push(key);
    }
    expect(keys).toHaveLength(1);
    expect(localStorage.getItem(keys[0])).toBe(v073Backup);
  });

  it('★ 同一备份连续导入两次幂等（序列化结果完全一致）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'));
    try {
      const first = importFromText(v073Backup);
      const second = importFromText(v073Backup);
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(exportJSON(second.db)).toBe(exportJSON(first.db));
    } finally {
      vi.useRealTimers();
    }
  });

  it('坏数据触发迁移失败：原数据字节级不变 + 只读锁定 + 回滚点保留', () => {
    const broken = v073Backup.replace('"jobTitle":"前端开发实习生"', '"jobTitle2":"字段名坏了"');
    localStorage.setItem(STORAGE_KEY, broken);
    const beforeBytes = broken.length;

    const result = loadDB();
    expect(isFailure(result)).toBe(true);
    if (!isFailure(result)) return;

    expect(localStorage.getItem(STORAGE_KEY)).toHaveLength(beforeBytes);
    expect(isPersistenceLocked()).toBe(true);
    expect(result.migration.backupKey).not.toBeNull();
    // 上锁后任何写入都是 no-op
    expect(saveDB(emptyDB())).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toHaveLength(beforeBytes);

    unlockPersistence();
  });

  it('导出 JSON 含 pluginStorage / aiSuggestions，但不含 requestLog（验收 13）', () => {
    const db = emptyDB();
    db.pluginStorage = [{ id: 'demo::k', pluginId: 'demo', key: 'k', value: 1, updatedAt: '2026-10-01T00:00:00.000Z' }];
    db.requestLog = [{
      id: 'r1', timestamp: '2026-10-01T00:00:00.000Z', pluginId: 'builtin:d14',
      baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', sentFieldsHash: 'abc', status: 'ok',
    }];
    db.aiSuggestions = [{
      id: 's1', pluginId: 'builtin:d14', targetType: 'question', targetId: null,
      fieldPath: 'text', content: '题干', status: 'pending', createdAt: '2026-10-01T00:00:00.000Z',
    }];
    const parsed = JSON.parse(exportJSON(db)) as Record<string, unknown> & {
      formatVersion: number; pluginStorage: unknown[]; requestLog?: unknown[]; aiSuggestions: unknown[];
    };
    expect(parsed.formatVersion).toBe(4);
    expect(parsed.pluginStorage).toHaveLength(1);
    expect(parsed.aiSuggestions).toHaveLength(1);
    expect(parsed.requestLog).toBeUndefined();
  });
});

/* ====================== v0.9：schema 4→5 迁移的安全三出口 ====================== */

describe('v0.9 迁移（4→5）：v0.8.0 备份导入零损失', () => {
  /**
   * 一份 v0.8.0 形状的真实备份：有插件两表，有只写文本的 resumeVersion，
   * 但**没有**简历三表、没有 resumeVersionId、没有 defaultResumeVersionId。
   * 这正是升级用户手里会拿着的那份文件。
   */
  const v080Backup = JSON.stringify({
    exportedAt: '2026-10-05T00:00:00.000Z',
    app: 'jobdesk',
    formatVersion: 3,
    version: 4,
    settings: {
      schemaVersion: 4,
      warnAfterDays: 3, staleAfterDays: 7, interviewResultWaitDays: 5, wishlistExpireDays: 7,
      resultPromptHour: 20, offerSilenceDays: 7, deadlineWarnDays: 3, dailyActionBudget: 5,
      channelFactor: { referral: 3, official: 2, boss: 1, shixiseng: 1, nowcoder: 1, liepin: 1, other: 1 },
      weeklyApplyGoal: 8, courseSlots: [], defaultResumeVersion: '前端-项目版',
      backupReminderDays: 7, fileLink: { enabled: false, readOnly: false }, encryption: { enabled: false },
      sync: { defaultPlatform: 'boss', statusMapOverrides: {}, autoRefreshActivity: true },
    },
    companies: [{ id: 'c1', name: '字节跳动', shortName: '字节', createdAt: '2026-09-01T00:00:00.000Z' }],
    applications: [{
      id: 'a1', companyId: 'c1', jobTitle: '前端开发实习生', jobType: 'daily', status: 'chatting',
      statusChangedAt: '2026-09-02T00:00:00.000Z', lastActivityAt: '2026-09-02T00:00:00.000Z',
      appliedAt: '2026-09-02', createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
      rejectedAtRound: null, silenceOverride: null, nextActionAt: null, deadlineAt: null, mutedUntil: null, tags: [],
      // ★ 老数据的「版本」只有一个手输文本
      resumeVersion: '前端-项目版',
    }],
    interviews: [{
      id: 'iv1', applicationId: 'a1', round: 1, totalRounds: null,
      scheduledAt: '2026-09-08T14:00:00.000Z', format: 'video', result: 'pending', prepChecklist: [],
    }],
    notes: [], experiences: [], questions: [], staging: [], events: [],
    pluginStorage: [], aiSuggestions: [],
  });

  it('★ 导入零错误零损失：原有数组逐条等价，简历三表为空，且不伪造版本', () => {
    const result = importFromText(v080Backup);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(v080Backup) as {
      applications: unknown[]; interviews: unknown[]; companies: unknown[]; settings: { defaultResumeVersion: string };
    };

    expect(result.db.applications).toHaveLength(parsed.applications.length);
    expect(result.db.applications[0]).toEqual(parsed.applications[0]);
    expect(result.db.interviews).toEqual(parsed.interviews);
    expect(result.db.companies).toEqual(parsed.companies);

    // 三张新表存在但空着 —— 迁移不许替用户造数据
    expect(result.db.resumes).toEqual([]);
    expect(result.db.resumeVersions).toEqual([]);
    expect(result.db.aiReports).toEqual([]);
    expect(result.db.settings.schemaVersion).toBe(SCHEMA_VERSION_CURRENT);

    // ★ 关键：不把老文本「升级」成绑定 id，也不补默认版本
    expect(result.db.applications[0].resumeVersionId).toBeUndefined();
    expect(result.db.applications[0].resumeBindLog).toBeUndefined();
    expect(result.db.settings.defaultResumeVersionId).toBeUndefined();
    // 老字段原样保留（复盘页要按它算「未绑定（旧数据）」）
    expect(result.db.applications[0].resumeVersion).toBe('前端-项目版');
    expect(result.db.settings.defaultResumeVersion).toBe(parsed.settings.defaultResumeVersion);
  });

  it('★ 迁移前回滚点存在且内容 = 原始字节（v4 启动路径）', () => {
    localStorage.setItem(STORAGE_KEY, v080Backup);
    const result = loadDB();
    expect(result.migration).toBeUndefined();

    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(ROLLBACK_PREFIX)) keys.push(key);
    }
    expect(keys).toHaveLength(1);
    expect(localStorage.getItem(keys[0])).toBe(v080Backup);
  });

  it('★ 同一备份连续导入两次幂等（序列化结果完全一致）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'));
    try {
      const first = importFromText(v080Backup);
      const second = importFromText(v080Backup);
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(exportJSON(second.db)).toBe(exportJSON(first.db));
    } finally {
      vi.useRealTimers();
    }
  });

  it('坏数据触发迁移失败：原数据字节级不变 + 只读锁定 + 回滚点保留', () => {
    const broken = v080Backup.replace('"jobTitle":"前端开发实习生"', '"jobTitle2":"字段名坏了"');
    localStorage.setItem(STORAGE_KEY, broken);
    const beforeBytes = broken.length;

    const result = loadDB();
    expect(isFailure(result)).toBe(true);
    if (!isFailure(result)) return;

    expect(localStorage.getItem(STORAGE_KEY)).toHaveLength(beforeBytes);
    expect(isPersistenceLocked()).toBe(true);
    expect(result.migration.backupKey).not.toBeNull();
    expect(saveDB(emptyDB())).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toHaveLength(beforeBytes);

    unlockPersistence();
  });

  it('导出 JSON 带上简历三表（formatVersion 4），仍然不含 requestLog', () => {
    const db = buildSampleDB(new Date('2026-10-21T09:00:00'));
    db.resumes = [{
      id: 'r1', name: '我的简历', templateId: 'tech-single',
      content: { sections: [] },
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    }];
    db.resumeVersions = [{
      id: 'v1', resumeId: 'r1', label: 'v1 初版', templateId: 'tech-single',
      content: { sections: [] }, createdAt: '2026-10-01T00:00:00.000Z',
    }];
    db.aiReports = [{
      id: 'rep1', pluginId: 'builtin:d19-diag', targetType: 'resume_diagnosis', targetId: 'r1',
      content: '总体还行', dimensions: [{ key: 'match', label: '匹配度', verdict: 'partial_match' }],
      createdAt: '2026-10-01T00:00:00.000Z',
    }];

    const parsed = JSON.parse(exportJSON(db)) as Record<string, unknown> & {
      formatVersion: number; resumes: unknown[]; resumeVersions: unknown[]; aiReports: unknown[]; requestLog?: unknown[];
    };
    expect(parsed.formatVersion).toBe(4);
    expect(parsed.resumes).toHaveLength(1);
    expect(parsed.resumeVersions).toHaveLength(1);
    expect(parsed.aiReports).toHaveLength(1);
    expect(parsed.requestLog).toBeUndefined();
  });
});
