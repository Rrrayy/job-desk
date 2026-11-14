/**
 * storage 层回归测试（QA D4 / D7）。
 *
 * 为什么这一层必须有测试：启动读失败时 App 会先渲染失败页再 return，
 * 但落盘的 `useEffect(..., [db])` 早已注册 —— 一次渲染就能把用户的真实数据
 * 覆盖成 485 字节的空骨架。这个洞不能靠「渲染顺序别赌」来堵，
 * 所以闸门放在 storage 层，测试也就打在 storage 层。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../types';
import { emptyDB } from './defaults';
import { SCHEMA_VERSION_CURRENT } from './migrate';
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
/**
 * 「结构坏到读不回来」的样本。
 *
 * v0.6 起必须用**当前版本号**：如果这里还写 schemaVersion:2，这份数据会被当成
 * 「合法的 v2 老库」走迁移（applications 是字符串 → 迁移后校验失败 → 走回滚点路径），
 * 那是另一条代码分支，测不到「当前版本校验失败 → 另存 failedAt 副本」这条主线。
 */
const BROKEN_V2 = JSON.stringify({
  settings: { schemaVersion: SCHEMA_VERSION_CURRENT },
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

/* ====================== v1.0.0：导出决策 + 沉默清单偏好 ====================== */

import {
  DEFAULT_SILENCE_PREFS,
  exportJSON,
  loadSilencePrefs,
  sanitizeSilencePrefs,
  saveSilencePrefs,
} from './storage';

describe('v1.0.0 · 导出带 offerDecision（条件展开）', () => {
  it('库里有决策 → 原样出现在导出里（理由和日期是用户资产，不能丢）', () => {
    const db = emptyDB();
    db.offerDecision = {
      applicationId: 'a1',
      decidedAt: '2026-11-01',
      reasonTags: ['薪资', '城市'],
      note: '离家近',
      declinedIds: ['a2'],
    };
    const parsed = JSON.parse(exportJSON(db)) as Record<string, unknown>;
    expect(parsed.offerDecision).toEqual({
      applicationId: 'a1',
      decidedAt: '2026-11-01',
      reasonTags: ['薪资', '城市'],
      note: '离家近',
      declinedIds: ['a2'],
    });
  });

  it('★ 库里没有决策 → 导出里连这个键都不出现（旧备份导出逐字节不变）', () => {
    const db = emptyDB();
    const parsed = JSON.parse(exportJSON(db)) as Record<string, unknown>;
    expect('offerDecision' in parsed).toBe(false);
  });

  it('导出 → 导入回来决策仍在（往返闭环）', () => {
    const db = emptyDB();
    db.offerDecision = { applicationId: 'a1', decidedAt: '2026-11-01', reasonTags: [] };
    localStorage.setItem(STORAGE_KEY, exportJSON(db));
    const boot = loadDB();
    expect(boot.error).toBeNull();
    expect(boot.db.offerDecision).toEqual({
      applicationId: 'a1',
      decidedAt: '2026-11-01',
      reasonTags: [],
    });
  });
});

describe('v1.0.0 · 沉默清单偏好（独立 key，不污染 ListFilterState）', () => {
  it('没存过 → 返回默认值（不隐藏已静音）', () => {
    expect(loadSilencePrefs()).toEqual(DEFAULT_SILENCE_PREFS);
    expect(loadSilencePrefs().hideMuted).toBe(false);
  });

  it('写入 → 读回：hideMuted 单独 round-trip', () => {
    saveSilencePrefs({ hideMuted: true });
    expect(loadSilencePrefs()).toEqual({ hideMuted: true });
  });

  it('脏数据（非对象 / 非 JSON / 缺字段）一律回默认值，不抛异常', () => {
    expect(sanitizeSilencePrefs(null)).toBeNull();
    expect(sanitizeSilencePrefs('true')).toBeNull();
    expect(sanitizeSilencePrefs([1])).toBeNull();
    expect(sanitizeSilencePrefs({ hideMuted: 'yes' })).toEqual({ hideMuted: false });

    localStorage.setItem('jobdesk.v1.silencePrefs', '{不是 JSON');
    expect(loadSilencePrefs()).toEqual(DEFAULT_SILENCE_PREFS);
  });

  it('★ 与列表过滤器共存在两个 key 上：存偏好不会改动 listFilters 的读回结果', () => {
    saveListFilters({
      status: 'chatting',
      channel: '',
      version: '',
      cities: [],
      keyword: '',
      sortKey: 'updatedAt',
      sortDir: 'desc',
    });
    const before = loadListFilters();
    saveSilencePrefs({ hideMuted: true });
    // ListFilterState 里不会多出 hideMuted —— 它是整对象 toEqual 的
    expect(loadListFilters()).toEqual(before);
    expect(Object.keys(loadListFilters() ?? {})).not.toContain('hideMuted');
  });
});

/* ================== v1.0.0 · 迁移 5→6 在存储层的三条契约 ================== */

import { importFromText } from './storage';

describe('v1.0.0 · v5 老备份 / 往返 / 更高版本', () => {
  /** 造一份有真实业务的库：1 家公司 + 1 条投递 + 1 条时间线 + 1 场面试 */
  function buildLiveDB(): DB {
    const db = emptyDB();
    db.companies = [{ id: 'c-1', name: '字节跳动', shortName: '字节', createdAt: '2026-09-01T00:00:00.000Z' }];
    db.applications = [
      {
        id: 'a-1',
        companyId: 'c-1',
        jobTitle: '抖音前端',
        status: 'chatting',
        channel: 'referral',
        appliedAt: '2026-09-02',
        statusChangedAt: '2026-10-01T01:00:00.000Z',
        lastActivityAt: '2026-10-01T01:00:00.000Z',
        createdAt: '2026-09-02T00:00:00.000Z',
        updatedAt: '2026-10-01T01:00:00.000Z',
      },
    ];
    db.notes = [
      {
        id: 'n-1',
        applicationId: 'a-1',
        type: 'chat',
        content: 'HR 说下周给答复',
        touchedAt: '2026-10-01T01:00:00.000Z',
      },
    ];
    return db;
  }

  /** 把当前形状的库降级成「v0.9.x 导出的 v5 备份」：版本号 5 + 导出格式 4，没有 v6 的任何键 */
  function v5ExportOf(db: DB): Record<string, unknown> {
    const payload = JSON.parse(exportJSON(db)) as Record<string, unknown>;
    const settings: Record<string, unknown> = {
      ...(payload.settings as Record<string, unknown>),
      schemaVersion: 5,
    };
    delete settings.offerWeights;
    delete payload.offerDecision;
    return { ...payload, settings, formatVersion: 4, version: 5 };
  }

  it('★ v5 老备份导入：数据零损失，且一个新字段都不回填（契约 3 / 4）', () => {
    const source = buildLiveDB();
    const raw = v5ExportOf(source);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(raw));

    const boot = loadDB();
    expect(boot.error).toBeNull();
    expect(boot.migration?.failed).toBeUndefined();

    // 版本抬到 6
    expect(boot.db.settings.schemaVersion).toBe(SCHEMA_VERSION_CURRENT);

    // 「零损失」的最强可断言形式：同一份数据**当成 v6 读**与**从 v5 迁移**必须逐字段相同
    // （校验器会把缺省字段补成规范化形状，所以基线也用校验器算，不拿手写的对象比）
    const asV6 = importFromText(
      JSON.stringify({ ...raw, settings: { ...(raw.settings as Record<string, unknown>), schemaVersion: SCHEMA_VERSION_CURRENT } }),
    );
    expect(asV6.ok).toBe(true);
    if (!asV6.ok) return;
    expect(boot.db.applications).toEqual(asV6.db.applications);
    expect(boot.db.companies).toEqual(asV6.db.companies);
    expect(boot.db.notes).toEqual(asV6.db.notes);

    // 业务值本身没被改写
    expect(boot.db.applications[0].jobTitle).toBe('抖音前端');
    expect(boot.db.applications[0].channel).toBe('referral');
    expect(boot.db.applications[0].lastActivityAt).toBe('2026-10-01T01:00:00.000Z');
    expect(boot.db.notes[0].content).toBe('HR 说下周给答复');

    // 契约 3：权重缺省不落库
    expect('offerWeights' in boot.db.settings).toBe(false);
    // 契约 4：旧投递不长 offer、旧公司不长五个新字段、全局不建空决策
    expect('offer' in boot.db.applications[0]).toBe(false);
    for (const field of ['scale', 'financingStage', 'website', 'industryDetail', 'employeeReview']) {
      expect(field in boot.db.companies[0]).toBe(false);
    }
    expect('offerDecision' in boot.db).toBe(false);
    // 契约 5：先备份后改 —— 回滚点必须真的写进去了
    expect(boot.db.settings.lastMigration?.backupKey).toBeTruthy();
  });

  it('★ 导出 → 导入往返稳定：再导再入一次，整库逐字段不变（规范化不会越跑越偏）', () => {
    const source = buildLiveDB();
    const first = importFromText(exportJSON(source));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = importFromText(exportJSON(first.db));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.db).toEqual(first.db);
    // 业务数据在往返里没有丢
    expect(second.db.applications[0].jobTitle).toBe('抖音前端');
    expect(second.db.notes[0].content).toBe('HR 说下周给答复');
    expect(second.db.companies[0].name).toBe('字节跳动');
  });

  it('★ 来自更新版本（v7）的备份：可读的人话报错 + 拒绝导入 + 本地库一个字节没动', () => {
    const source = buildLiveDB();
    localStorage.setItem(STORAGE_KEY, 'LOCAL-GOOD-DATA');

    const raw = v5ExportOf(source);
    const settings = { ...(raw.settings as Record<string, unknown>), schemaVersion: SCHEMA_VERSION_CURRENT + 1 };
    const result = importFromText(JSON.stringify({ ...raw, settings }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // PRD §4.6 契约 6 要求的是「文案让人知道该升级工具」，不是一个裸版本号
    expect(result.error).toContain('请先升级工具');
    expect(result.error).toContain(String(SCHEMA_VERSION_CURRENT + 1));
    // 拒绝导入不许顺带清空本地数据
    expect(localStorage.getItem(STORAGE_KEY)).toBe('LOCAL-GOOD-DATA');
  });

  it('★ 本地库里存着 v7 数据时（未来版本回滚场景）：给可读提示、原数据一字不动、且上锁不许覆写', () => {
    const source = buildLiveDB();
    const raw = v5ExportOf(source);
    const settings = { ...(raw.settings as Record<string, unknown>), schemaVersion: SCHEMA_VERSION_CURRENT + 1 };
    const future = JSON.stringify({ ...raw, settings });
    localStorage.setItem(STORAGE_KEY, future);

    const boot = loadDB();
    // ① 有可读提示（不是「数据已损坏」这种把高版本当坏数据的话术）
    expect(boot.error).toContain('更新版本');
    expect(boot.error).toContain(`v${SCHEMA_VERSION_CURRENT + 1}`);
    // ② 原始数据既没被清空、也没被空库覆盖
    expect(boot.migration?.failed).toBe(true);
    expect(boot.migration?.reason).toContain('请升级工具');
    expect(localStorage.getItem(STORAGE_KEY)).toBe(future);
    saveDB(emptyDB());
    expect(localStorage.getItem(STORAGE_KEY)).toBe(future);
    expect(isPersistenceLocked()).toBe(true);
    // ③ 原文交给用户，允许自行升级后再导回来
    expect(boot.migration?.raw).toBe(future);
  });
});
