import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DB } from '../types';
import { SCHEMA_VERSION_CURRENT, migrateV1ToV2, migrateV2ToV3, resolveSchemaVersion } from './migrate';

/** 造一份「v0.1 真实导出」形状的数据（26 条投递 + 多条 note + 面试） */
function buildV1Raw(): Record<string, unknown> {
  const companies: unknown[] = [];
  const applications: unknown[] = [];
  const interviews: unknown[] = [];
  const notes: unknown[] = [];

  for (let i = 0; i < 26; i += 1) {
    const companyId = `c_${i}`;
    const appId = `app_${i}`;
    companies.push({
      id: companyId,
      name: `公司${i}`,
      shortName: `司${i}`,
      city: '北京',
      createdAt: `2025-02-${`${i + 1}`.padStart(2, '0')}T09:00:00.000Z`,
    });
    applications.push({
      id: appId,
      companyId,
      jobTitle: `前端开发实习生${i}`,
      jobType: i % 2 === 0 ? 'daily' : 'summer',
      city: '北京',
      channel: i % 3 === 0 ? 'referral' : 'boss',
      appliedAt: `2025-02-${`${i + 1}`.padStart(2, '0')}`,
      status: i % 5 === 0 ? 'chatting' : i % 5 === 1 ? 'applied' : i % 5 === 2 ? 'scheduled' : i % 5 === 3 ? 'rejected' : 'offer',
      statusChangedAt: `2025-03-01T10:00:${`${i}`.padStart(2, '0')}.000Z`,
      lastActivityAt: `2025-03-02T11:00:${`${i}`.padStart(2, '0')}.000Z`,
      jdUrl: `https://www.zhipin.com/job_detail/${i}.html`,
      resumeVersion: 'v3-前端-项目版',
      salaryText: '200-300/天',
      daysPerWeek: 3,
      durationMonths: 4,
      silenceOverride: null,
      rejectedAtRound: null,
      rejectReason: undefined,
      nextActionAt: null,
      priority: 2,
      tags: ['想去'],
      createdAt: `2025-02-01T09:00:00.000Z`,
      updatedAt: `2025-03-02T11:00:00.000Z`,
    });
    if (i % 4 === 0) {
      interviews.push({
        id: `iv_${i}`,
        applicationId: appId,
        round: 1,
        totalRounds: 2,
        scheduledAt: `2025-03-05T14:00:00.000Z`,
        durationMin: 45,
        format: 'video',
        locationOrLink: '飞书会议',
        interviewer: '一面面试官',
        prepChecklist: [{ id: 'p1', text: '项目难点', done: true }],
        result: 'passed',
        notes: '还行',
      });
    }
    notes.push({
      id: `n_${i}_a`,
      applicationId: appId,
      type: 'chat',
      content: '打了个招呼',
      auto: false,
      touchedAt: `2025-03-02T11:00:${`${i}`.padStart(2, '0')}.000Z`,
    });
    if (i % 3 === 0) {
      notes.push({
        id: `n_${i}_b`,
        applicationId: appId,
        type: 'system',
        content: '状态：已投递 → 已沟通',
        auto: true,
        touchedAt: `2025-03-01T10:00:${`${i}`.padStart(2, '0')}.000Z`,
      });
    }
  }

  return {
    exportedAt: '2025-03-10T00:00:00.000Z',
    app: 'jobdesk',
    version: 1,
    settings: {
      schemaVersion: 1,
      warnAfterDays: 3,
      staleAfterDays: 7,
      interviewResultWaitDays: 5,
      wishlistExpireDays: 7,
      resultPromptHour: 20,
      channelFactor: { referral: 3, official: 2, boss: 1, shixiseng: 1, nowcoder: 1, other: 1 },
      weeklyApplyGoal: 8,
      courseSlots: [{ weekday: 2, start: '08:00', end: '09:40', name: '数据结构' }],
      defaultResumeVersion: 'v3-前端-项目版',
    },
    companies,
    applications,
    interviews,
    notes,
  };
}

const NOW = '2025-03-13T12:00:00.000Z';

describe('migrateV1ToV2', () => {
  it('无损：4 个数组条数与每条字段逐项相等', () => {
    const raw = buildV1Raw();
    const result = migrateV1ToV2(raw, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const db = result.db;

    expect(db.companies).toHaveLength((raw.companies as unknown[]).length);
    expect(db.applications).toHaveLength((raw.applications as unknown[]).length);
    expect(db.interviews).toHaveLength((raw.interviews as unknown[]).length);
    expect(db.notes).toHaveLength((raw.notes as unknown[]).length);

    const rawApps = raw.applications as Array<Record<string, unknown>>;
    db.applications.forEach((app, index) => {
      const source = rawApps[index];
      for (const key of [
        'id',
        'companyId',
        'jobTitle',
        'jobType',
        'city',
        'channel',
        'appliedAt',
        'status',
        'statusChangedAt',
        'lastActivityAt',
        'jdUrl',
        'resumeVersion',
        'salaryText',
        'daysPerWeek',
        'durationMonths',
        'silenceOverride',
        'rejectedAtRound',
        'nextActionAt',
        'priority',
        'tags',
        'createdAt',
        'updatedAt',
      ]) {
        expect(app[key as keyof typeof app]).toEqual(source[key]);
      }
    });

    const rawNotes = raw.notes as Array<Record<string, unknown>>;
    db.notes.forEach((note, index) => {
      expect(note.id).toBe(rawNotes[index].id);
      expect(note.touchedAt).toBe(rawNotes[index].touchedAt);
      expect(note.type).toBe(rawNotes[index].type);
      expect(note.auto).toBe(rawNotes[index].auto);
    });
  });

  it('★ 幂等：同一份数据迁移两次，结果完全相同', () => {
    const raw = buildV1Raw();
    const once = migrateV2ToV3(raw, { now: NOW });
    expect(once.ok).toBe(true);
    if (!once.ok) return;

    const twice = migrateV2ToV3(once.db, { now: NOW });
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;

    expect(twice.changed).toBe(false);
    expect(twice.db).toEqual(once.db);
  });

  it('已是当前版本的输入原样返回（连对象引用都不变）', () => {
    const once = migrateV2ToV3(buildV1Raw(), { now: NOW });
    if (!once.ok) throw new Error('前置迁移失败');
    const again = migrateV2ToV3(once.db, { now: '2030-01-01T00:00:00.000Z' });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.db).toBe(once.db);
    expect(again.changed).toBe(false);
  });

  it('v1 直通当前版本：lastMigration 记的是 1 → 当前版本（不是 1 → 2）', () => {
    const result = migrateV2ToV3(buildV1Raw(), { now: NOW });
    if (!result.ok) throw new Error('迁移失败');
    expect(result.db.settings.schemaVersion).toBe(SCHEMA_VERSION_CURRENT);
    expect(result.db.settings.lastMigration?.from).toBe(1);
    expect(result.db.settings.lastMigration?.to).toBe(SCHEMA_VERSION_CURRENT);
  });

  it('v2 备份 → v3：补上 backupReminderDays 与 fileLink 默认值，events 原样透传', () => {
    const v2 = migrateV1ToV2(buildV1Raw(), { now: NOW });
    if (!v2.ok) throw new Error('前置迁移失败');
    const source = {
      ...v2.db,
      settings: { ...v2.db.settings, schemaVersion: 2 },
      events: [{ id: 'ev1', title: '算法课', kind: 'course', start: '08:00', end: '09:40', weekly: true, weekday: 1 }],
    };
    const result = migrateV2ToV3(source, { now: NOW });
    if (!result.ok) throw new Error('迁移失败');
    expect(result.db.settings.backupReminderDays).toBe(7);
    expect(result.db.settings.fileLink).toEqual({ enabled: false, readOnly: false });
    // 不凭空给老事件塞 color / notes
    expect(result.db.events[0]).toEqual(source.events[0]);
  });

  it('比当前版本还新的数据 → 明确报错，绝不猜测结构', () => {
    const raw = buildV1Raw();
    (raw.settings as Record<string, unknown>).schemaVersion = SCHEMA_VERSION_CURRENT + 1;
    const result = migrateV2ToV3(raw, { now: NOW });
    expect(result.ok).toBe(false);
  });

  it('只加不减：三个新数组是空数组，settings 补上 sync', () => {
    const result = migrateV1ToV2(buildV1Raw(), { now: NOW });
    if (!result.ok) throw new Error('迁移失败');
    expect(result.db.experiences).toEqual([]);
    expect(result.db.questions).toEqual([]);
    expect(result.db.staging).toEqual([]);
    // v0.8：插件三表同样空表起步
    expect(result.db.pluginStorage).toEqual([]);
    expect(result.db.requestLog).toEqual([]);
    expect(result.db.aiSuggestions).toEqual([]);
    // v0.6：AppSettings 的类型就是「当前版本」，v1 直通时一步到位写当前版本
    expect(result.db.settings.schemaVersion).toBe(SCHEMA_VERSION_CURRENT);
    expect(result.db.settings.sync.defaultPlatform).toBe('boss');
    expect(result.db.settings.sync.autoRefreshActivity).toBe(true);
    expect(result.db.settings.lastMigration?.at).toBe(NOW);
  });

  it('保留 v1 的自定义设置（不把用户设置重置成默认值）', () => {
    const raw = buildV1Raw();
    (raw.settings as Record<string, unknown>).warnAfterDays = 5;
    (raw.settings as Record<string, unknown>).weeklyApplyGoal = 12;
    const result = migrateV1ToV2(raw, { now: NOW });
    if (!result.ok) throw new Error('迁移失败');
    expect(result.db.settings.warnAfterDays).toBe(5);
    expect(result.db.settings.weeklyApplyGoal).toBe(12);
    expect(result.db.settings.courseSlots).toHaveLength(1);
  });

  it('v0.4：validateV2 把旧 courseSlots 一次性迁进 events 并清空旧字段', async () => {
    const raw = buildV1Raw();
    const migrated = migrateV1ToV2(raw, { now: NOW });
    if (!migrated.ok) throw new Error('迁移失败');
    // 迁移产物本身 events 是空的，courseSlots 还在 —— 转换发生在 v2 校验层
    expect(migrated.db.events).toEqual([]);
    const { validateV2 } = await import('./validateV2');
    const verified = validateV2(migrated.db);
    if (!verified.ok) throw new Error(verified.error);
    expect(verified.db.settings.courseSlots).toHaveLength(0);
    expect(verified.db.events).toHaveLength(1);
    expect(verified.db.events[0]).toMatchObject({
      title: '数据结构',
      kind: 'course',
      weekly: true,
      weekday: 2,
      start: '08:00',
      end: '09:40',
    });
    // 幂等：再过一遍校验，课不会复活成两份
    const again = validateV2(verified.db);
    if (!again.ok) throw new Error(again.error);
    expect(again.db.events).toHaveLength(1);
  });

  it('失败时返回说人话的错误，不 throw', () => {
    const raw = buildV1Raw();
    delete (raw.applications as Array<Record<string, unknown>>)[3].jobTitle;
    const result = migrateV1ToV2(raw, { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('jobTitle');
    expect(result.error).toContain('第 4 条');
  });

  it('顶层不是对象 → 明确报错', () => {
    expect(migrateV1ToV2(null, { now: NOW }).ok).toBe(false);
    expect(migrateV1ToV2('x', { now: NOW }).ok).toBe(false);
    expect(migrateV1ToV2([], { now: NOW }).ok).toBe(false);
  });

  it('来自更新版本的备份 → 明确拒绝并给升级提示', () => {
    const result = migrateV1ToV2(
      { settings: { schemaVersion: SCHEMA_VERSION_CURRENT + 1 }, applications: [] },
      { now: NOW },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('升级');
  });

  it('版本解析优先级：settings.schemaVersion > raw.schemaVersion > raw.version', () => {
    expect(resolveSchemaVersion({ settings: { schemaVersion: 2 }, schemaVersion: 1, version: 1 })).toBe(2);
    expect(resolveSchemaVersion({ schemaVersion: 1, version: 1 })).toBe(1);
    expect(resolveSchemaVersion({ version: 1 })).toBe(1);
    expect(resolveSchemaVersion({})).toBe('unknown');
    expect(resolveSchemaVersion({ settings: { schemaVersion: 'x' } })).toBe('unknown');
  });

  it('★ 源码里不允许出现 new Date( / Date.now( （迁移必须无时间读取）', () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const source = readFileSync(`${here}migrate.ts`, 'utf-8');
    // 允许出现在注释里，所以只检查非注释行
    const codeLines = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'));
    const offenders = codeLines.filter((line) => /new Date\(|Date\.now\(/.test(line));
    expect(offenders).toEqual([]);
  });

  it('迁移结果能通过 v2 校验（不会写出一个自己读不回来的库）', async () => {
    const { validateV2 } = await import('./validateV2');
    const result = migrateV1ToV2(buildV1Raw(), { now: NOW });
    if (!result.ok) throw new Error('迁移失败');
    const valid = validateV2(result.db);
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    expect((valid.db as DB).applications).toHaveLength(26);
  });
});

describe('v0.7 JD 字段 additive 往返', () => {
  const NOW = '2026-10-21T16:00:00.000Z';

  it('jdText / jdCapturedAt / jdLinkDeadAt 经 v2→v3 校验后原样保留', () => {
    const db = {
      settings: { schemaVersion: 2, theme: 'warm', defaultResumeVersion: '', silenceWarnDays: 3, silenceStaleDays: 7, backupReminderDays: 7, dailyActionBudget: 5 },
      companies: [{ id: 'c1', name: '杭州星澜智慧云图智能科技', createdAt: NOW, updatedAt: NOW }],
      applications: [{
        id: 'a1', companyId: 'c1', jobTitle: 'Agent 研发实习生', status: 'applied',
        statusChangedAt: NOW, lastActivityAt: NOW, createdAt: NOW, updatedAt: NOW,
        jdUrl: 'https://www.zhipin.com/job_detail/x.html',
        jdText: '岗位职责\n写 Agent。',
        jdCapturedAt: NOW,
        jdLinkDeadAt: NOW,
      }],
      interviews: [], notes: [], experiences: [], questions: [], events: [], trash: [],
    } as unknown as DB;

    const migrated = migrateV2ToV3(structuredClone(db), { now: NOW });
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    const app = migrated.db.applications[0];
    expect(app.jdText).toBe('岗位职责\n写 Agent。');
    expect(app.jdCapturedAt).toBe(NOW);
    expect(app.jdLinkDeadAt).toBe(NOW);
    expect(app.jdUrl).toBe('https://www.zhipin.com/job_detail/x.html');
    // 幂等：再走一遍不变
    const again = migrateV2ToV3(structuredClone(migrated.db) as unknown as typeof db, { now: NOW });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.db.applications[0].jdText).toBe('岗位职责\n写 Agent。');
  });

  it('老备份没有这三个字段 → 补 undefined，不拦导入', () => {
    const db = {
      settings: { schemaVersion: 2, theme: 'warm', defaultResumeVersion: '', silenceWarnDays: 3, silenceStaleDays: 7, backupReminderDays: 7, dailyActionBudget: 5 },
      companies: [{ id: 'c1', name: '旧公司', createdAt: NOW, updatedAt: NOW }],
      applications: [{
        id: 'a1', companyId: 'c1', jobTitle: '前端实习', status: 'applied',
        statusChangedAt: NOW, lastActivityAt: NOW, createdAt: NOW, updatedAt: NOW,
      }],
      interviews: [], notes: [], experiences: [], questions: [], events: [], trash: [],
    } as unknown as DB;
    const migrated = migrateV2ToV3(db, { now: NOW });
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.db.applications[0].jdText).toBeUndefined();
    expect(migrated.db.applications[0].jdCapturedAt).toBeUndefined();
    expect(migrated.db.applications[0].jdLinkDeadAt).toBeUndefined();
  });
});

/* ======================= v0.8：schema 3 → 4 迁移 + 校验器扩展 ======================= */

import { migrateV3ToV4 } from './migrate';
import { validateV2 } from './validateV2';

/** 造一份「v0.7.3 真实导出」形状的 v3 库（没有插件三表 / settings.ai / written / kind） */
function buildV3Raw(): Record<string, unknown> {
  return {
    exportedAt: '2026-10-01T00:00:00.000Z',
    app: 'jobdesk',
    formatVersion: 2,
    version: 3,
    settings: {
      schemaVersion: 3,
      warnAfterDays: 3,
      staleAfterDays: 7,
      interviewResultWaitDays: 5,
      wishlistExpireDays: 7,
      resultPromptHour: 20,
      offerSilenceDays: 7,
      deadlineWarnDays: 3,
      dailyActionBudget: 5,
      channelFactor: { referral: 3, official: 2, boss: 1, shixiseng: 1, nowcoder: 1, liepin: 1, other: 1 },
      weeklyApplyGoal: 8,
      courseSlots: [],
      defaultResumeVersion: '',
      backupReminderDays: 7,
      fileLink: { enabled: false, readOnly: false },
      encryption: { enabled: false },
      sync: { defaultPlatform: 'boss', statusMapOverrides: {}, autoRefreshActivity: true },
    },
    companies: [{ id: 'c1', name: '字节跳动', shortName: '字节', createdAt: '2026-09-01T00:00:00.000Z' }],
    applications: [
      {
        id: 'a1', companyId: 'c1', jobTitle: '前端开发实习生', jobType: 'daily', status: 'chatting',
        statusChangedAt: '2026-09-02T00:00:00.000Z', lastActivityAt: '2026-09-02T00:00:00.000Z',
        appliedAt: '2026-09-02', createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
        rejectedAtRound: null, silenceOverride: null, nextActionAt: null, deadlineAt: null, mutedUntil: null,
        tags: [], priority: 2,
      },
      {
        id: 'a2', companyId: 'c1', jobTitle: '后端开发实习生', jobType: 'daily', status: 'rejected', rejectedAtRound: 2,
        statusChangedAt: '2026-09-10T00:00:00.000Z', lastActivityAt: '2026-09-10T00:00:00.000Z',
        appliedAt: '2026-09-05', createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z',
        silenceOverride: null, nextActionAt: null, deadlineAt: null, mutedUntil: null, tags: [],
      },
    ],
    interviews: [
      {
        id: 'iv1', applicationId: 'a2', round: 2, totalRounds: null,
        scheduledAt: '2026-09-08T14:00:00.000Z', format: 'video', result: 'failed',
        prepChecklist: [],
      },
    ],
    notes: [],
    experiences: [],
    questions: [],
    staging: [],
    events: [],
  };
}

describe('v0.8 · migrateV3ToV4', () => {
  it('v3 → v4：三张插件空表落库 + settings.ai 缺省补齐 + schemaVersion 4', () => {
    const result = migrateV3ToV4(buildV3Raw(), { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const db = result.db;
    expect(result.changed).toBe(true);
    expect(db.pluginStorage).toEqual([]);
    expect(db.requestLog).toEqual([]);
    expect(db.aiSuggestions).toEqual([]);
    expect(db.settings.schemaVersion).toBe(4);
    expect(db.settings.ai).toEqual({ baseURL: '', model: '', isLocal: false });
    expect(db.settings.lastMigration).toMatchObject({ from: 3, to: 4, at: NOW });
  });

  it('★ 只加不减：v0.7.3 形状的既有数据逐字段原样（含面试记录与挂点）', () => {
    const raw = buildV3Raw();
    const result = migrateV3ToV4(raw, { now: NOW });
    if (!result.ok) throw new Error('迁移失败');
    const db = result.db;
    expect(db.applications).toHaveLength(2);
    expect(db.applications[0]).toEqual((raw.applications as unknown[])[0]);
    expect(db.applications[1].status).toBe('rejected');
    expect(db.applications[1].rejectedAtRound).toBe(2);
    expect(db.interviews).toEqual(raw.interviews);
    expect(db.companies).toEqual(raw.companies);
  });

  it('★ 幂等：v3 迁移两次，第二次 changed=false 且结果与第一次完全一致', () => {
    const once = migrateV3ToV4(buildV3Raw(), { now: NOW });
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = migrateV3ToV4(once.db, { now: '2030-01-01T00:00:00.000Z' });
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(twice.changed).toBe(false);
    expect(twice.db).toEqual(once.db);
  });

  it('链式迁移：v1 备份直通 v4，lastMigration 仍记「1 → 4」', () => {
    const result = migrateV2ToV3(buildV1Raw(), { now: NOW });
    if (!result.ok) throw new Error('迁移失败');
    expect(result.db.settings.schemaVersion).toBe(SCHEMA_VERSION_CURRENT);
    expect(result.db.settings.lastMigration?.from).toBe(1);
    expect(result.db.settings.lastMigration?.to).toBe(SCHEMA_VERSION_CURRENT);
    expect(result.db.pluginStorage).toEqual([]);
  });

  it('坏数据：v3 缺关键字段 → 明确报错，不产出半个库', () => {
    const raw = buildV3Raw();
    delete (raw.applications as Array<Record<string, unknown>>)[0].jobTitle;
    const result = migrateV3ToV4(raw, { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('jobTitle');
  });

  it('只接受 v3：直接喂 v1/v2 数据 → 报错并指路分发入口', () => {
    expect(migrateV3ToV4({ settings: { schemaVersion: 2 }, applications: [] }, { now: NOW }).ok).toBe(false);
    expect(migrateV3ToV4(null, { now: NOW }).ok).toBe(false);
    expect(migrateV3ToV4({ settings: { schemaVersion: 99 }, applications: [] }, { now: NOW }).ok).toBe(false);
  });

  it('settings.ai 已有值时原样保留（不重置成未配置）', () => {
    const raw = buildV3Raw();
    (raw.settings as Record<string, unknown>).ai = { baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', isLocal: true };
    const result = migrateV3ToV4(raw, { now: NOW });
    if (!result.ok) throw new Error('迁移失败');
    expect(result.db.settings.ai).toEqual({ baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', isLocal: true });
  });
});

describe('v0.8 · 校验器（written / kind / 三新表）', () => {
  it('written 进状态白名单；kind 合法值保留、非法值回落 undefined', async () => {
    const raw = buildV3Raw();
    const apps = raw.applications as Array<Record<string, unknown>>;
    apps[0].status = 'written';
    (raw.interviews as Array<Record<string, unknown>>)[0].kind = 'tech';
    const result = validateV2(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.db.applications[0].status).toBe('written');
    expect(result.db.interviews[0].kind).toBe('tech');
  });

  it('非法 kind 回落 undefined（模式照 events.kind），不拦导入', async () => {
    const raw = buildV3Raw();
    (raw.interviews as Array<Record<string, unknown>>)[0].kind = '玄学面';
    const result = validateV2(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.db.interviews[0].kind).toBeUndefined();
  });

  it('round=0（笔试记录）不再被改成 1', async () => {
    const raw = buildV3Raw();
    (raw.interviews as Array<Record<string, unknown>>)[0] = {
      id: 'iv0', applicationId: 'a1', round: 0, scheduledAt: '2026-09-09T10:00:00.000Z',
      format: 'onsite', kind: 'written', result: 'pending',
    };
    const result = validateV2(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.db.interviews[0].round).toBe(0);
    expect(result.db.interviews[0].kind).toBe('written');
  });

  it('插件三表：缺失补 []，行内容校验，PluginStorage 按联合主键去重', async () => {
    const raw = buildV3Raw();
    raw.pluginStorage = [
      { id: 'p1', pluginId: 'demo', key: 'session', value: { a: 1 }, updatedAt: NOW },
      { id: 'p2', pluginId: 'demo', key: 'session', value: { a: 2 }, updatedAt: NOW },
      { id: 'p3', pluginId: 'demo', key: 'other', value: 1, updatedAt: NOW },
    ];
    raw.requestLog = [{
      id: 'r1', timestamp: NOW, pluginId: 'builtin:d14', baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3:8b', sentFieldsHash: 'abc123', status: 'ok',
    }];
    raw.aiSuggestions = [{
      id: 's1', pluginId: 'builtin:d17', targetType: 'staging_field', targetId: null,
      fieldPath: 'companyName', content: '字节跳动', status: 'pending', createdAt: NOW,
    }];
    const result = validateV2(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.db.pluginStorage).toHaveLength(2);
    expect(result.db.pluginStorage.every((row) => row.id === `${row.pluginId}::${row.key}` || row.id.length > 0)).toBe(true);
    expect(result.db.requestLog).toHaveLength(1);
    expect(result.db.aiSuggestions).toHaveLength(1);
  });

  it('插件三表：行类型错了必须报错（不静默纠错）', async () => {
    const badLog = buildV3Raw();
    badLog.requestLog = [{ id: 'r1', status: 'unknown-status' }];
    expect(validateV2(badLog).ok).toBe(false);

    const badSuggestion = buildV3Raw();
    badSuggestion.aiSuggestions = [{ id: 's1', targetType: '不存在的目标' }];
    expect(validateV2(badSuggestion).ok).toBe(false);

    const badStorage = buildV3Raw();
    badStorage.pluginStorage = [{ key: 'no-plugin-id' }];
    expect(validateV2(badStorage).ok).toBe(false);
  });

  it('三表缺失（v0.7.3 备份）→ 补空表，不报错', async () => {
    const result = validateV2(buildV3Raw());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.db.pluginStorage).toEqual([]);
    expect(result.db.requestLog).toEqual([]);
    expect(result.db.aiSuggestions).toEqual([]);
    expect(result.db.settings.schemaVersion).toBe(SCHEMA_VERSION_CURRENT);
    expect(result.db.settings.ai).toEqual({ baseURL: '', model: '', isLocal: false });
  });
});
