import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DB } from '../types';
import { migrateV1ToV2, resolveSchemaVersion } from './migrate';

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
    const once = migrateV1ToV2(raw, { now: NOW });
    expect(once.ok).toBe(true);
    if (!once.ok) return;

    const twice = migrateV1ToV2(once.db, { now: NOW });
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;

    expect(twice.changed).toBe(false);
    expect(twice.db).toEqual(once.db);
  });

  it('已是 v2 的输入原样返回（连对象引用都不变）', () => {
    const once = migrateV1ToV2(buildV1Raw(), { now: NOW });
    if (!once.ok) throw new Error('前置迁移失败');
    const again = migrateV1ToV2(once.db, { now: '2030-01-01T00:00:00.000Z' });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.db).toBe(once.db);
    expect(again.changed).toBe(false);
  });

  it('只加不减：三个新数组是空数组，settings 补上 sync', () => {
    const result = migrateV1ToV2(buildV1Raw(), { now: NOW });
    if (!result.ok) throw new Error('迁移失败');
    expect(result.db.experiences).toEqual([]);
    expect(result.db.questions).toEqual([]);
    expect(result.db.staging).toEqual([]);
    expect(result.db.settings.schemaVersion).toBe(2);
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
    const result = migrateV1ToV2({ settings: { schemaVersion: 3 }, applications: [] }, { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('v3');
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
