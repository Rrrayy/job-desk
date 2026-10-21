/**
 * 导入增量合并（v0.5 / D4）测试。
 *
 * 核心断言是**幂等**：同一份备份连导两次，第二次必须 0 新增 0 冲突。
 * 这条比「能合并」重要得多 —— 合并算法写错的典型症状就是「导一次多一条」，
 * 而用户会把它当成「数据自己长了」。
 */

import { describe, expect, it } from 'vitest';
import type { DB } from '../types';
import { emptyDB } from './defaults';
import { buildSampleDB } from './sample';
import {
  applicationKey,
  diffApplication,
  mergeImport,
  normalizeCompanyName,
} from './merge';

const NOW = new Date('2026-10-21T12:00:00.000Z');

function sample(): DB {
  return buildSampleDB(NOW);
}

describe('去重键', () => {
  it('公司名只忽略空白与大小写', () => {
    expect(normalizeCompanyName('  Byte Dance ')).toBe('bytedance');
    expect(normalizeCompanyName('字节跳动')).toBe('字节跳动');
  });

  it('同公司不同岗位算两条', () => {
    const a = applicationKey({ companyName: '字节跳动', jobTitle: '前端', appliedAt: '2026-09-01' });
    const b = applicationKey({ companyName: '字节跳动', jobTitle: '后端', appliedAt: '2026-09-01' });
    expect(a).not.toBe(b);
  });

  it('同公司同岗位不同投递日期算两条（投了两次是两件事）', () => {
    const a = applicationKey({ companyName: '字节跳动', jobTitle: '前端', appliedAt: '2026-09-01' });
    const b = applicationKey({ companyName: '字节跳动', jobTitle: '前端', appliedAt: '2026-10-01' });
    expect(a).not.toBe(b);
  });
});

describe('合并幂等', () => {
  it('同一份备份导进空库：全部新增，无冲突', () => {
    const incoming = sample();
    const plan = mergeImport(emptyDB(), incoming);
    expect(plan.counts.added).toBe(incoming.applications.length);
    expect(plan.counts.addedCompanies).toBe(incoming.companies.length);
    expect(plan.counts.conflicts).toBe(0);
  });

  it('同一份备份连续导两次：第二次 0 新增 0 更新 0 冲突', () => {
    const incoming = sample();
    const first = mergeImport(emptyDB(), incoming);
    const second = mergeImport(first.db, incoming);

    expect(second.counts.added).toBe(0);
    expect(second.counts.addedCompanies).toBe(0);
    expect(second.counts.addedInterviews).toBe(0);
    expect(second.counts.addedNotes).toBe(0);
    expect(second.counts.conflicts).toBe(0);
    expect(second.db.applications).toHaveLength(first.db.applications.length);
    expect(second.db.interviews).toHaveLength(first.db.interviews.length);
    expect(second.db.notes).toHaveLength(first.db.notes.length);
  });

  it('导进自己导出的结果，等于什么都没做（条目数一条不差）', () => {
    const base = sample();
    const plan = mergeImport(base, base);
    expect(plan.counts.added).toBe(0);
    expect(plan.counts.unchanged).toBe(base.applications.length);
    expect(plan.db.applications).toHaveLength(base.applications.length);
  });
});

describe('增量：不覆盖本地', () => {
  it('本地有、备份也有但内容不同 → 报冲突，默认保留本地', () => {
    const local = sample();
    const incoming = sample();
    // 构造差异：备份里有一条状态不同
    const target = local.applications[0];
    incoming.applications = incoming.applications.map((app, index) =>
      index === 0 ? { ...app, status: 'offer', statusChangedAt: NOW.toISOString() } : app,
    );

    const plan = mergeImport(local, incoming);
    expect(plan.counts.conflicts).toBe(1);
    expect(plan.conflicts[0].localId).toBe(target.id);
    // 保留本地：状态没被改
    expect(plan.db.applications.find((a) => a.id === target.id)!.status).toBe(target.status);
  });

  it('本地新增的记录不会被导入冲掉', () => {
    const local = sample();
    const before = local.applications.length;
    const plan = mergeImport(local, emptyDB());
    expect(plan.db.applications).toHaveLength(before);
    expect(plan.counts.added).toBe(0);
  });

  it('备份里多出来的投递会被补进来，本地的原样保留', () => {
    const local = emptyDB();
    const incoming = sample();
    const plan = mergeImport(local, incoming);
    expect(plan.db.applications).toHaveLength(incoming.applications.length);
    // 本地的设置不动
    expect(plan.db.settings).toEqual(local.settings);
  });
});

describe('冲突裁决：用户选覆盖', () => {
  it('选覆盖 → 非保护字段更新，保护字段仍保留本地', () => {
    const local = sample();
    const incoming = sample();
    const target = local.applications[0];
    // 备份里：状态变了、优先级被清掉、简历版本被改成别的
    incoming.applications = incoming.applications.map((app, index) =>
      index === 0
        ? {
            ...app,
            status: 'offer' as const,
            priority: undefined,
            resumeVersion: 'v99',
            statusChangedAt: NOW.toISOString(),
          }
        : app,
    );

    const plan = mergeImport(local, incoming, { overwriteLocalIds: new Set([target.id]) });
    const merged = plan.db.applications.find((a) => a.id === target.id)!;

    // 非保护字段：用备份的值
    expect(merged.status).toBe('offer');
    // 保护字段（优先级 / 简历版本）：仍是本地的，哪怕备份要清空它
    expect(merged.priority).toBe(target.priority);
    expect(merged.resumeVersion).toBe(target.resumeVersion);
  });

  it('冲突行会带出逐字段差异，标出哪些受保护', () => {
    const local = sample();
    const target = local.applications[0];

    const diffs = diffApplication(target, {
      ...target,
      status: 'offer',
      priority: undefined,
      resumeVersion: 'v99',
    });
    const statusDiff = diffs.find((d) => d.field === 'status')!;
    const priorityDiff = diffs.find((d) => d.field === 'priority')!;
    const resumeDiff = diffs.find((d) => d.field === 'resumeVersion')!;

    expect(statusDiff.protected).toBe(false);
    expect(priorityDiff.protected).toBe(true);
    expect(resumeDiff.protected).toBe(true);
    // 受保护的字段要能看出「本地是什么、备份想改成什么」
    expect(priorityDiff.local).not.toBe(priorityDiff.incoming);
  });
});

describe('关联数据', () => {
  it('新增投递带进来的面试与备注一起落库，且指向本地 id', () => {
    const local = emptyDB();
    const incoming = sample();
    const plan = mergeImport(local, incoming);

    expect(plan.counts.addedInterviews).toBe(incoming.interviews.length);
    expect(plan.counts.addedNotes).toBe(incoming.notes.length);

    const localIds = new Set(plan.db.applications.map((a) => a.id));
    for (const interview of plan.db.interviews) {
      expect(localIds.has(interview.applicationId)).toBe(true);
    }
    for (const note of plan.db.notes) {
      expect(localIds.has(note.applicationId)).toBe(true);
    }
  });

  it('重复导入不会把面试和备注复制一遍', () => {
    const incoming = sample();
    const first = mergeImport(emptyDB(), incoming);
    const second = mergeImport(first.db, incoming);
    expect(second.db.interviews).toHaveLength(first.db.interviews.length);
    expect(second.db.notes).toHaveLength(first.db.notes.length);
  });

  it('孤儿面试（父投递不在备份里）不会被插进来', () => {
    const local = emptyDB();
    const incoming = emptyDB();
    incoming.interviews.push({
      id: 'iv_orphan',
      applicationId: 'app_not_exist',
      round: 1,
      scheduledAt: NOW.toISOString(),
      format: 'video',
      result: 'pending',
    });
    const plan = mergeImport(local, incoming);
    expect(plan.db.interviews.some((i) => i.id === 'iv_orphan')).toBe(false);
  });
});

describe('不修改入参', () => {
  it('local 与 incoming 在合并后保持原样', () => {
    const local = sample();
    const incoming = sample();
    const localCount = local.applications.length;
    const incomingCount = incoming.applications.length;
    mergeImport(local, incoming);
    expect(local.applications).toHaveLength(localCount);
    expect(incoming.applications).toHaveLength(incomingCount);
  });
});
