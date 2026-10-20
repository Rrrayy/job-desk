import { describe, expect, it } from 'vitest';
import type { NormalizedRecord } from '../../adapters/types';
import type { DB } from '../../types';
import { emptyDB } from '../defaults';
import { NORMALIZE_VERSION } from './normalize';
import { apply, plan, revertSync, stageKeyOfItem, stageKeyOfRecord } from './engine';
import type { PlannedRow } from './types';

const NOW = '2025-03-13T12:00:00.000Z';

function record(overrides: Partial<NormalizedRecord> = {}): NormalizedRecord {
  return {
    companyName: '字节跳动',
    jobTitle: '抖音前端开发实习生',
    status: '沟通中',
    confidence: { companyName: 'high', jobTitle: 'high', status: 'high' },
    overall: 'high',
    ...overrides,
  };
}

function baseDB(): DB {
  const db = emptyDB();
  db.companies.push({ id: 'c_1', name: '字节跳动', createdAt: '2025-01-01T00:00:00.000Z' });
  db.applications.push({
    id: 'app_1',
    companyId: 'c_1',
    jobTitle: '抖音前端开发实习生',
    status: 'applied',
    statusChangedAt: '2025-03-01T10:00:00.000Z',
    lastActivityAt: '2025-03-01T10:00:00.000Z',
    createdAt: '2025-03-01T10:00:00.000Z',
    updatedAt: '2025-03-01T10:00:00.000Z',
    sync: {
      platform: 'boss',
      matchKey: '字节跳动|抖音前端开发实习生',
      matchKeyVersion: NORMALIZE_VERSION,
    },
    userEditedAt: {},
  });
  return db;
}

const planInput = (db: DB, records: NormalizedRecord[]) => ({
  records,
  db,
  platform: 'boss' as const,
  capturedAt: NOW,
  overrides: {},
  autoRefreshActivity: true,
  now: NOW,
});

describe('plan() 不变式', () => {
  it('每条 record 恰好产生一行，计数之和等于识别条数', () => {
    const db = baseDB();
    const records = [
      record(),
      record({ companyName: '美团', jobTitle: '到家前端实习生', status: '已投递' }),
      record({ companyName: '小红书', jobTitle: '前端开发实习生', status: '待沟通' }),
    ];
    const result = plan(planInput(db, records));
    expect(result.rows).toHaveLength(records.length);
    expect(result.parsedCount).toBe(records.length);
    const total = Object.values(result.counts).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(records.length);
    expect(new Set(result.rows.map((row) => row.key)).size).toBe(records.length);
  });

  it('冲突行默认不勾（硬规则 2：一律以用户为准）', () => {
    const db = baseDB();
    db.applications[0].status = 'scheduled';
    const result = plan(planInput(db, [record({ status: '沟通中' })]));
    const row = result.rows[0];
    expect(row.kind).toBe('conflict');
    expect(row.blockedBy).toBe('platform-behind');
    expect(row.defaultChecked).toBe(false);
  });

  it('用户刚手改过 status → 只能是 conflict / unchanged，绝不可能是 update（硬规则 1）', () => {
    const db = baseDB();
    db.applications[0].userEditedAt = { status: '2025-03-10T10:00:00.000Z' };
    const result = plan(planInput(db, [record({ status: '邀请面试', lastContactAt: '2025-03-05T10:00:00.000Z' })]));
    expect(result.rows[0].kind).toBe('conflict');
    expect(result.rows[0].blockedBy).toBe('user-edited');
    expect(result.rows[0].warnings.join(' ')).toContain('手动改过');
  });

  it('手改时间早于平台时间时，仍按推进判定（平台更新鲜）', () => {
    const db = baseDB();
    db.applications[0].userEditedAt = { status: '2025-03-01T10:00:00.000Z' };
    const result = plan(planInput(db, [record({ status: '邀请面试', lastContactAt: '2025-03-12T10:00:00.000Z' })]));
    expect(result.rows[0].kind).toBe('update');
  });

  it('状态一样、无字段差异 → unchanged，且只刷心跳', () => {
    const db = baseDB();
    db.applications[0].status = 'chatting';
    db.applications[0].jobTitle = '抖音前端开发实习生';
    db.applications[0].channel = 'boss';
    const result = plan(planInput(db, [record({ status: '沟通中' })]));
    expect(result.rows[0].kind).toBe('unchanged');
    expect(result.rows[0].changes).toHaveLength(0);
    expect(result.rows[0].defaultChecked).toBe(false);
  });

  it('状态映射不出来 → staged/unmapped，整行不落库', () => {
    const db = baseDB();
    const result = plan(planInput(db, [record({ status: '待沟通' })]));
    expect(result.rows[0].kind).toBe('staged');
    expect(result.rows[0].stagedReason).toBe('unmapped');
    expect(result.counts.staged).toBe(1);
  });

  it('多条疑似候选 → staged/ambiguous，不猜', () => {
    const db = baseDB();
    // 去掉 matchKey 快照，强制走「公司 + 岗位相似度」这条模糊匹配
    db.applications[0].sync = undefined;
    db.applications.push({
      ...db.applications[0],
      id: 'app_2',
      jobTitle: '抖音前端开发实习生（北京）',
    });
    const result = plan(planInput(db, [record({ jobTitle: '抖音前端开发实习生' })]));
    expect(result.rows[0].kind).toBe('staged');
    expect(result.rows[0].stagedReason).toBe('ambiguous');
    expect(result.rows[0].candidateAppIds?.length).toBe(2);
  });

  it('缺岗位名的新记录进暂存（不造一条没有岗位的脏数据）', () => {
    const db = emptyDB();
    const result = plan(planInput(db, [record({ companyName: '新公司', jobTitle: undefined })]));
    expect(result.rows[0].kind).toBe('staged');
  });

  it('matchKey 命中时按快照匹配（用户改过岗位名也能命中）', () => {
    const db = baseDB();
    db.applications[0].jobTitle = '抖音前端开发（改过的名字）';
    const result = plan(planInput(db, [record()]));
    expect(result.rows[0].kind).toBe('update');
    expect(result.rows[0].matchedBy).toBe('matchKey');
  });

  it('补全型字段只在本地为空时写入', () => {
    const db = baseDB();
    db.applications[0].city = '北京';
    const result = plan(planInput(db, [record({ status: '沟通中', city: '上海', salaryText: '300/天' })]));
    const fields = result.rows[0].changes.map((change) => change.field);
    expect(fields).not.toContain('city');
    expect(fields).toContain('salaryText');
  });
});

describe('apply() 与 note 语义', () => {
  it('★ 20 条沉默 20 天的记录 + 一次无变化的同步 → lastActivityAt 与 note 完全不变', () => {
    const db = emptyDB();
    const records: NormalizedRecord[] = [];
    for (let i = 0; i < 20; i += 1) {
      const companyId = `c_${i}`;
      const appId = `app_${i}`;
      db.companies.push({ id: companyId, name: `公司${i}`, createdAt: '2025-02-01T00:00:00.000Z' });
      db.applications.push({
        id: appId,
        companyId,
        jobTitle: `前端开发实习生${i}`,
        status: 'chatting',
        channel: 'boss',
        statusChangedAt: '2025-02-20T10:00:00.000Z',
        lastActivityAt: '2025-02-20T10:00:00.000Z',
        createdAt: '2025-02-20T10:00:00.000Z',
        updatedAt: '2025-02-20T10:00:00.000Z',
      });
      // 平台只说「沟通中」，且没有给出任何业务时间
      records.push(
        record({
          companyName: `公司${i}`,
          jobTitle: `前端开发实习生${i}`,
          status: '沟通中',
          lastContactAt: undefined,
        }),
      );
    }

    const result = plan(planInput(db, records));
    expect(result.counts.unchanged).toBe(20);
    expect(result.counts.update).toBe(0);

    const applied = apply(db, {
      rows: result.rows,
      now: NOW,
      capturedAt: NOW,
      platform: 'boss',
    });

    expect(applied.db.notes).toHaveLength(0);
    for (let i = 0; i < 20; i += 1) {
      expect(applied.db.applications[i].lastActivityAt).toBe('2025-02-20T10:00:00.000Z');
      // 心跳可以刷，但它不参与沉默计算
      expect(applied.db.applications[i].sync?.lastSyncedAt).toBe(NOW);
    }
  });

  it('状态前进 → 写一条 sync note，touchedAt 用平台时间（不是抓取时刻）', () => {
    const db = baseDB();
    const result = plan(
      planInput(db, [record({ status: '邀请面试', lastContactAt: '2025-03-12T02:20:00.000Z' })]),
    );
    const applied = apply(db, { rows: result.rows, now: NOW, capturedAt: NOW, platform: 'boss' });
    expect(applied.written).toBe(1);
    expect(applied.db.applications[0].status).toBe('chatting');
    expect(applied.db.notes).toHaveLength(1);
    expect(applied.db.notes[0].type).toBe('sync');
    expect(applied.db.notes[0].auto).toBe(true);
    expect(applied.db.notes[0].touchedAt).toBe('2025-03-12T02:20:00.000Z');
    expect(applied.db.notes[0].touchedAt).not.toBe(NOW);
    expect(applied.db.applications[0].lastActivityAt).toBe('2025-03-12T02:20:00.000Z');
  });

  it('★ 只有平台时间更新、状态没变 → 写「有新消息」note，且不写状态字段', () => {
    const db = baseDB();
    db.applications[0].status = 'chatting';
    const result = plan(
      planInput(db, [record({ status: '沟通中', lastContactAt: '2025-03-12T09:00:00.000Z' })]),
    );
    const applied = apply(db, { rows: result.rows, now: NOW, capturedAt: NOW, platform: 'boss' });
    expect(applied.db.notes).toHaveLength(1);
    expect(applied.db.notes[0].content).toContain('新消息');
    expect(applied.db.applications[0].lastActivityAt).toBe('2025-03-12T09:00:00.000Z');
  });

  it('★ 平台时间比本地旧 → 不写 note，也不把沉默基准往回调', () => {
    const db = baseDB();
    db.applications[0].status = 'chatting';
    db.applications[0].lastActivityAt = '2025-03-10T00:00:00.000Z';
    db.applications[0].statusChangedAt = '2025-03-10T00:00:00.000Z';
    const result = plan(
      planInput(db, [record({ status: '沟通中', lastContactAt: '2025-03-01T00:00:00.000Z' })]),
    );
    const applied = apply(db, { rows: result.rows, now: NOW, capturedAt: NOW, platform: 'boss' });
    expect(applied.db.notes).toHaveLength(0);
    expect(applied.db.applications[0].lastActivityAt).toBe('2025-03-10T00:00:00.000Z');
  });

  it('冲突行未勾选 → 进暂存（reason=conflict），主库不受影响', () => {
    const db = baseDB();
    db.applications[0].status = 'scheduled';
    const result = plan(planInput(db, [record({ status: '沟通中' })]));
    const applied = apply(db, { rows: result.rows, now: NOW, capturedAt: NOW, platform: 'boss' });
    expect(applied.written).toBe(0);
    expect(applied.staged).toBe(1);
    expect(applied.db.staging).toHaveLength(1);
    expect(applied.db.staging[0].reason).toBe('conflict');
    expect(applied.db.applications[0].status).toBe('scheduled');
  });

  it('撤销后 applications / notes / staging 与同步前 deep-equal', () => {
    const db = baseDB();
    const before = JSON.parse(JSON.stringify(db)) as DB;
    const result = plan(
      planInput(db, [
        record({ status: '邀请面试', lastContactAt: '2025-03-12T02:20:00.000Z' }),
        record({ companyName: '美团', jobTitle: '到家前端实习生', status: '已投递' }),
        record({ companyName: '小红书', jobTitle: '前端实习生', status: '待沟通' }),
      ]),
    );
    const applied = apply(db, { rows: result.rows, now: NOW, capturedAt: NOW, platform: 'boss' });
    expect(applied.db.applications.length).toBeGreaterThan(before.applications.length);

    const draft = JSON.parse(JSON.stringify(applied.db)) as DB;
    revertSync(draft, applied.undo);

    expect(draft.applications).toEqual(before.applications);
    expect(draft.notes).toEqual(before.notes);
    expect(draft.staging).toEqual(before.staging);
    expect(draft.companies).toEqual(before.companies);
  });

  it('同一条记录同步两次 → 第二次全部落「无变化」，不产生重复投递', () => {
    const db = baseDB();
    const rec = record({ status: '邀请面试', lastContactAt: '2025-03-12T02:20:00.000Z' });
    const first = plan(planInput(db, [rec]));
    const afterFirst = apply(db, { rows: first.rows, now: NOW, capturedAt: NOW, platform: 'boss' }).db;
    expect(afterFirst.applications).toHaveLength(1);

    const second = plan(planInput(afterFirst, [rec]));
    expect(second.rows[0].kind).toBe('unchanged');
    const afterSecond = apply(afterFirst, {
      rows: second.rows,
      now: NOW,
      capturedAt: NOW,
      platform: 'boss',
    }).db;
    expect(afterSecond.applications).toHaveLength(1);
    expect(afterSecond.applications[0].status).toBe('chatting');
  });

  it('同一批里出现重复记录 → 第二条进暂存，不新建两条', () => {
    const db = emptyDB();
    const rec = record({ companyName: '美团', jobTitle: '到家前端实习生', status: '已投递' });
    const result = plan(planInput(db, [rec, rec]));
    expect(result.rows[0].kind).toBe('new');
    expect(result.rows[1].kind).toBe('staged');
    const applied = apply(db, { rows: result.rows, now: NOW, capturedAt: NOW, platform: 'boss' });
    expect(applied.db.applications).toHaveLength(1);
  });

  it('暂存区 key 与 plan 的行 key 同源（重新同步时能清掉残留）', () => {
    const rec = record({ status: '待沟通' });
    const db = baseDB();
    const first = plan(planInput(db, [rec]));
    const applied = apply(db, { rows: first.rows, now: NOW, capturedAt: NOW, platform: 'boss' });
    expect(applied.db.staging).toHaveLength(1);
    expect(stageKeyOfItem(applied.db.staging[0])).toBe(stageKeyOfRecord(rec));

    // 第二次同步同一条（仍未映射）→ 暂存不应累积成 2 条
    const second = plan(planInput(applied.db, [rec]));
    const applied2 = apply(applied.db, { rows: second.rows, now: NOW, capturedAt: NOW, platform: 'boss' });
    expect(applied2.db.staging).toHaveLength(1);
  });

  it('channel 是 set-once：本地已有值时不覆盖', () => {
    const db = baseDB();
    db.applications[0].channel = 'referral';
    const result = plan(planInput(db, [record({ status: '邀请面试', lastContactAt: '2025-03-12T02:20:00.000Z' })]));
    const applied = apply(db, { rows: result.rows, now: NOW, capturedAt: NOW, platform: 'boss' });
    expect(applied.db.applications[0].channel).toBe('referral');
  });

  it('user-only 字段永不被同步改写', () => {
    const db = baseDB();
    db.applications[0].priority = 3;
    db.applications[0].tags = ['想去'];
    db.applications[0].resumeVersion = 'v3';
    const result = plan(planInput(db, [record({ status: '邀请面试', lastContactAt: '2025-03-12T02:20:00.000Z' })]));
    const applied = apply(db, { rows: result.rows, now: NOW, capturedAt: NOW, platform: 'boss' });
    expect(applied.db.applications[0].priority).toBe(3);
    expect(applied.db.applications[0].tags).toEqual(['想去']);
    expect(applied.db.applications[0].resumeVersion).toBe('v3');
  });

  it('「邀请面试」只映射到 chatting + 待办提示，绝不自动造 Interview', () => {
    const db = baseDB();
    const result = plan(
      planInput(db, [record({ status: '邀请面试', lastContactAt: '2025-03-12T02:20:00.000Z' })]),
    );
    const applied = apply(db, { rows: result.rows, now: NOW, capturedAt: NOW, platform: 'boss' });
    expect(applied.db.applications[0].status).toBe('chatting');
    expect(applied.db.applications[0].status).not.toBe('scheduled');
    expect(applied.db.interviews).toHaveLength(0);
    expect(result.rows[0].warnings.join(' ')).toContain('去约时间');
  });
});

/**
 * QA D1 回归集：解析失败的条目必须真的进暂存区。
 *
 * 修复前：`plan()` 恒返回 `unparsed: []`，`apply()` 只处理 rows，
 * 于是第 ② 步写「不会丢，会进待归类」，第 ④ 步写「没有遗留待归类记录」，`db.staging` 0 → 0。
 */
describe('解析失败（unparsed）不静默丢 · QA D1', () => {
  const garbage = [
    { rawSnippet: '??? 找不到公司名', reason: '这一行没有公司名' },
    { rawSnippet: '2025-13-45 状态：不知道', reason: '日期格式不认识' },
    { rawSnippet: '————————', reason: '这一行没有公司名' },
  ];

  it('★ 粘 3 条垃圾文本 → unparsed 3 条、进暂存 3 条、五类计数仍守恒', () => {
    const db = emptyDB();
    const records = [record({ companyName: '美团', jobTitle: '前端实习生', status: '已投递' })];
    const result = plan({ ...planInput(db, records), unparsed: garbage });

    // 1. plan 真的把 unparsed 交出来了（以前这里恒为 []）
    expect(result.unparsed).toHaveLength(3);
    expect(result.parsedCount).toBe(1);

    // 2. 五类计数只统计 record，之和 === records.length（unparsed 不掺进来）
    const total = Object.values(result.counts).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(records.length);

    // 3. apply 把它们写进 staging，条数一一对应
    const applied = apply(db, {
      rows: result.rows,
      now: NOW,
      capturedAt: NOW,
      platform: 'boss',
      unparsed: result.unparsed,
    });
    const staged = applied.db.staging.filter((item) => item.reason === 'unparsed');
    expect(staged).toHaveLength(result.unparsed.length);
    expect(applied.staged).toBe(3);

    // 4. 原文片段 + 失败原因 + 平台 + 时间都带出来了（用户能看见丢了什么）
    expect(staged.map((item) => item.rawSnippet)).toEqual(garbage.map((item) => item.rawSnippet));
    expect(staged[0].reasonText).toBe('这一行没有公司名');
    expect(staged[0].platform).toBe('boss');
    expect(staged[0].capturedAt).toBe(NOW);
    expect(staged[0].parsed.companyName).toBe('');
  });

  it('同一段垃圾文本重复粘贴 → 暂存不堆叠（按原文片段去重）', () => {
    const db = emptyDB();
    const unparsed = [{ rawSnippet: '???', reason: '这一行没有公司名' }];
    const first = plan({ ...planInput(db, []), unparsed });
    const afterFirst = apply(db, {
      rows: first.rows,
      now: NOW,
      capturedAt: NOW,
      platform: 'boss',
      unparsed: first.unparsed,
    }).db;
    expect(afterFirst.staging).toHaveLength(1);

    const second = plan({ ...planInput(afterFirst, []), unparsed });
    const afterSecond = apply(afterFirst, {
      rows: second.rows,
      now: NOW,
      capturedAt: NOW,
      platform: 'boss',
      unparsed: second.unparsed,
    }).db;
    expect(afterSecond.staging).toHaveLength(1);
  });

  it('空白片段不进暂存（否则用户会看到一条什么都看不到的空行）', () => {
    const db = emptyDB();
    const result = plan({ ...planInput(db, []), unparsed: [{ rawSnippet: '   \n  ', reason: '空行' }] });
    const applied = apply(db, {
      rows: result.rows,
      now: NOW,
      capturedAt: NOW,
      platform: 'boss',
      unparsed: result.unparsed,
    });
    expect(applied.db.staging).toHaveLength(0);
  });

  it('撤销能把「解析失败」的暂存档一起还原掉', () => {
    const db = emptyDB();
    const result = plan({ ...planInput(db, []), unparsed: garbage });
    const applied = apply(db, {
      rows: result.rows,
      now: NOW,
      capturedAt: NOW,
      platform: 'boss',
      unparsed: result.unparsed,
    });
    const draft = JSON.parse(JSON.stringify(applied.db)) as DB;
    revertSync(draft, applied.undo);
    expect(draft.staging).toHaveLength(0);
  });
});

/**
 * QA D3 回归集：勾选冲突行必须真的有用，且时间线里不许出现「A → A」。
 */
describe('冲突行的二选一语义 · QA D3', () => {
  /** 本地「面试中」，平台「已发 Offer」，且用户刚手改过 → plan 判为 conflict */
  function conflictCase(): { db: DB; rows: PlannedRow[] } {
    const db = baseDB();
    db.applications[0].status = 'scheduled';
    db.applications[0].userEditedAt = { status: '2025-03-13T11:00:00.000Z' };
    const result = plan(
      planInput(db, [record({ status: '已发 Offer', lastContactAt: '2025-03-12T02:20:00.000Z' })]),
    );
    expect(result.rows[0].kind).toBe('conflict');
    expect(result.rows[0].defaultChecked).toBe(false);
    return { db, rows: result.rows };
  }

  it('不勾 = 保留本地：状态不变、暂存 +1、不写任何 note', () => {
    const { db, rows } = conflictCase();
    const applied = apply(db, { rows, now: NOW, capturedAt: NOW, platform: 'boss' });
    expect(applied.db.applications[0].status).toBe('scheduled');
    expect(applied.db.applications[0].statusChangedAt).toBe('2025-03-01T10:00:00.000Z');
    expect(applied.db.notes).toHaveLength(0);
    expect(applied.db.staging[0].reason).toBe('conflict');
  });

  it('★ 勾选 = 用平台状态覆盖本地，note 是「旧 → 新」而不是「A → A」', () => {
    const { db, rows } = conflictCase();
    const applied = apply(db, {
      rows: rows.map((row) => ({ ...row, checked: true })),
      now: NOW,
      capturedAt: NOW,
      platform: 'boss',
    });
    expect(applied.db.applications[0].status).toBe('offer');

    const note = applied.db.notes[0];
    expect(note).toBeDefined();
    const pair = /状态 (.+?) → (.+?)（/.exec(note.content);
    expect(pair).not.toBeNull();
    expect(pair?.[1]).not.toBe(pair?.[2]);
    expect(applied.db.staging).toHaveLength(0);
  });

  it('★ 全矩阵不变式：任何 sync note 里的「A → B」都满足 A ≠ B', () => {
    // 本地状态 × 平台原文 × 勾选与否，穷举一遍。
    // 这条不变式比「盯某一个用例」更狠：只要有人把 statusChanged 改回
    // 「看平台想写什么」而不是「实际写成什么」，这里必然红。
    const localStatuses = ['scheduled', 'chatting', 'applied'] as const;
    const platformRaw = ['已发 Offer', '沟通中', '已投递', '邀请面试'];
    let checkedCount = 0;

    for (const local of localStatuses) {
      for (const raw of platformRaw) {
        for (const checked of [false, true]) {
          const db = baseDB();
          db.applications[0].status = local;
          db.applications[0].userEditedAt = { status: '2025-03-13T11:00:00.000Z' };
          const result = plan(
            planInput(db, [record({ status: raw, lastContactAt: '2025-03-12T02:20:00.000Z' })]),
          );
          const applied = apply(db, {
            rows: result.rows.map((row) => ({ ...row, checked })),
            now: NOW,
            capturedAt: NOW,
            platform: 'boss',
          });

          for (const note of applied.db.notes.filter((item) => item.type === 'sync')) {
            const pair = /状态 (.+?) → (.+?)（/.exec(note.content);
            if (!pair) continue;
            expect(pair[1]).not.toBe(pair[2]);
            checkedCount += 1;
          }

          // 状态没有真的变，就不许出现任何「状态 X → Y」
          const statusBefore = db.applications[0].status;
          const statusAfter = applied.db.applications[0].status;
          if (statusBefore === statusAfter) {
            const claims = applied.db.notes.filter((note) => /状态 .+ → /.test(note.content));
            expect(claims).toHaveLength(0);
          }
        }
      }
    }

    // 保证这条不变式不是「一条 note 都没写」空转通过的
    expect(checkedCount).toBeGreaterThan(0);
  });
});

describe('行 key 与暂存 key', () => {
  it('同一份 record 两次计算得到同一个 key（稳定）', () => {
    const rec = record();
    expect(stageKeyOfRecord(rec)).toBe(stageKeyOfRecord(rec));
  });

  it('岗位名里的城市与括号不影响 key', () => {
    expect(stageKeyOfRecord(record({ jobTitle: '前端开发实习生（北京）' }))).toBe(
      stageKeyOfRecord(record({ jobTitle: '前端开发实习生' })),
    );
  });
});

/** 类型检查用：PlannedRow 的 checked 可选 */
const _typeCheck: PlannedRow['checked'] = undefined;
void _typeCheck;
