/**
 * 投递 ↔ 版本绑定的回归（T06 的数据侧）。
 *
 * 每一条都对应一个「用户会真的心疼」的场景：
 * - 改个简历版本把沉默天数归零 / 往时间线塞一条假记录（F9 红线，显式回归）；
 * - 绑到草稿或已删的版本 → 统计口径立刻被污染；
 * - 留痕被刷爆 → 「当时投的哪版」的历史被手抖冲掉；
 * - 版本删除后投递上的 id 被顺手清掉 → 投递记录永久丢失「当时投的哪份」（A-12）。
 */

import { describe, expect, it } from 'vitest';
import type { Application, DB } from '../types';
import { emptyDB } from '../lib/defaults';
import { createResume, saveVersion, softDeleteVersion } from './versions';
import { bindResumeVersion, candidateVersions, resolveBoundVersion } from './bind';
import { UNBOUND_LEGACY_LABEL, UNLABELED_RESUME_LABEL } from '../lib/rules';
import { isDeleted } from '../lib/trash';

const AT = '2026-03-01T10:00:00.000Z';
const AT2 = '2026-03-05T10:00:00.000Z';

function freshDB(): DB {
  return emptyDB();
}

function makeApp(overrides: Partial<Application> = {}): Application {
  return {
    id: overrides.id ?? 'app-1',
    companyId: 'c-1',
    jobTitle: '前端实习',
    status: 'applied',
    statusChangedAt: '2026-02-20T01:00:00.000Z',
    lastActivityAt: '2026-02-20T01:00:00.000Z',
    createdAt: '2026-02-20T01:00:00.000Z',
    updatedAt: '2026-02-20T01:00:00.000Z',
    ...overrides,
  };
}

/** 一份简历 + n 个冻结版本；返回版本 id 列表（旧→新，v1 在前） */
function seedResume(db: DB, name = '前端 - 主投', n = 2): { resumeId: string; versionIds: string[] } {
  const resume = createResume(db, { name, templateId: 'tech-single', at: AT });
  const versionIds: string[] = [];
  for (let index = 1; index <= n; index += 1) {
    const result = saveVersion(db, resume.id, `v${index}`, AT);
    if (!result.ok) throw new Error(`存版本失败：${result.reason}`);
    versionIds.push(result.id);
  }
  return { resumeId: resume.id, versionIds };
}

describe('resolveBoundVersion：显示侧的三分支 + 未标注', () => {
  it('bound：id 指着活版本 → 用版本自己的名字（改名跟新名）', () => {
    const db = freshDB();
    const { versionIds } = seedResume(db);
    const app = makeApp({ resumeVersionId: versionIds[0], resumeVersion: '旧快照名' });

    const view = resolveBoundVersion(db, app);
    expect(view.state).toBe('bound');
    expect(view.label).toBe('v1');
    expect(view.versionId).toBe(versionIds[0]);
  });

  it('★ dangling（真删）：id 不在库里 → 退回绑定时的快照名 +（已删除），绝不空白', () => {
    const db = freshDB();
    const app = makeApp({ resumeVersionId: 'ver-gone', resumeVersion: 'v3-前端-项目版' });

    const view = resolveBoundVersion(db, app);
    expect(view.state).toBe('dangling');
    expect(view.label).toBe('v3-前端-项目版（已删除）');
    expect(view.versionId).toBe('ver-gone');
  });

  it('★ dangling（软删）：版本还在回收站 → 同样算悬空，用版本名兜底', () => {
    const db = freshDB();
    const { versionIds } = seedResume(db);
    softDeleteVersion(db, versionIds[0], AT);
    const app = makeApp({ resumeVersionId: versionIds[0] });

    const view = resolveBoundVersion(db, app);
    expect(view.state).toBe('dangling');
    expect(view.label).toBe('v1（已删除）');
  });

  it('dangling 且连快照名都没有 → 「已删除的版本（已删除）」，显示仍然有着落', () => {
    const db = freshDB();
    const view = resolveBoundVersion(db, makeApp({ resumeVersionId: 'ver-gone' }));
    expect(view.state).toBe('dangling');
    expect(view.label).toBe('已删除的版本（已删除）');
  });

  it('legacy：只有旧文本快照 → 统一「未绑定（旧数据）」，不按文本各分一桶', () => {
    const db = freshDB();
    const view = resolveBoundVersion(db, makeApp({ resumeVersion: 'v3-前端-项目版' }));
    expect(view.state).toBe('legacy');
    expect(view.label).toBe(UNBOUND_LEGACY_LABEL);
    expect(view.versionId).toBeNull();
  });

  it('none：什么都没有 → 未标注', () => {
    const db = freshDB();
    const view = resolveBoundVersion(db, makeApp());
    expect(view.state).toBe('none');
    expect(view.label).toBe(UNLABELED_RESUME_LABEL);
  });
});

describe('candidateVersions：只出「活简历 × 活版本」', () => {
  it('★ 软删的版本、已删简历名下的版本都不进候选 —— 绑草稿是结构性不可能（草稿不是版本）', () => {
    const db = freshDB();
    const main = seedResume(db, '前端 - 主投', 2);
    const backup = seedResume(db, '后端 - 备用', 1);
    softDeleteVersion(db, main.versionIds[0], AT); // 主简历的 v1 被删

    const candidates = candidateVersions(db);
    // 剩下的只有：主简历的 v2 + 备用简历的 v1（顺序按排序器而定，不在这里断言先后）
    expect([...candidates.map((item) => `${item.resumeName}·${item.label}`)].sort()).toEqual([
      '前端 - 主投·v2',
      '后端 - 备用·v1',
    ]);
    expect(candidates.every((item) => item.versionId !== main.versionIds[0])).toBe(true);
    expect(backup.versionIds).toHaveLength(1);
  });

  it('候选按简历名 → 版本名排序：同名 v1 出现时能靠简历名分辨', () => {
    const db = freshDB();
    seedResume(db, '乙公司简历', 1);
    seedResume(db, '甲公司简历', 2);
    expect(candidateVersions(db).map((item) => item.resumeName)).toEqual([
      '甲公司简历',
      '甲公司简历',
      '乙公司简历',
    ]);
  });
});

describe('bindResumeVersion：写入、留痕、上限、拒绝', () => {
  it('★ 绑定成功：id + 快照 + 留痕一条，快照是绑定当时的版本名', () => {
    const db = freshDB();
    const { versionIds } = seedResume(db);
    const app = makeApp();
    db.applications = [app];

    expect(bindResumeVersion(db, app.id, versionIds[0], AT2)).toBe(true);
    expect(app.resumeVersionId).toBe(versionIds[0]);
    expect(app.resumeVersion).toBe('v1');
    expect(app.resumeBindLog).toEqual([{ versionId: versionIds[0], label: 'v1', at: AT2 }]);
    expect(app.updatedAt).toBe(AT2);
  });

  it('★★ F9 显式回归：改绑**不**碰 lastActivityAt / statusChangedAt，**不**写 notes/时间线', () => {
    const db = freshDB();
    const { versionIds } = seedResume(db, '前端 - 主投', 2);
    const app = makeApp();
    db.applications = [app];
    const notesBefore = db.notes.length;
    const before = {
      lastActivityAt: app.lastActivityAt,
      statusChangedAt: app.statusChangedAt,
    };

    bindResumeVersion(db, app.id, versionIds[0], AT2);
    bindResumeVersion(db, app.id, versionIds[1], '2026-03-06T10:00:00.000Z'); // 再改绑一次

    expect(app.lastActivityAt).toBe(before.lastActivityAt);
    expect(app.statusChangedAt).toBe(before.statusChangedAt);
    expect(db.notes).toHaveLength(notesBefore);
    // 留痕只记在 resumeBindLog 里，不借道 note 进时间线
    expect(app.resumeBindLog).toHaveLength(2);
  });

  it('改绑三件套：旧条目保留、新条目追加 —— 上一条就是旧值，串起来能看出「从哪改到哪」', () => {
    const db = freshDB();
    const { versionIds } = seedResume(db, '前端 - 主投', 2);
    const app = makeApp();
    db.applications = [app];

    bindResumeVersion(db, app.id, versionIds[0], AT2);
    bindResumeVersion(db, app.id, versionIds[1], '2026-03-06T10:00:00.000Z');

    expect(app.resumeBindLog?.map((entry) => entry.label)).toEqual(['v1', 'v2']);
    expect(app.resumeBindLog?.[1].versionId).toBe(versionIds[1]);
    expect(app.resumeVersion).toBe('v2');
  });

  it('留痕定长 ≤ 20：第 21 次改绑丢最旧的（留最近的历史才有回看价值）', () => {
    const db = freshDB();
    const { versionIds } = seedResume(db, '前端 - 主投', 1);
    const app = makeApp();
    db.applications = [app];

    // 25 次改绑，交替换目标让每次都真的写一条
    for (let index = 0; index < 25; index += 1) {
      const target = index % 2 === 0 ? versionIds[0] : null;
      expect(bindResumeVersion(db, app.id, target, `2026-03-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`)).toBe(true);
    }
    expect(app.resumeBindLog).toHaveLength(20);
    // 最旧的被丢：现存最老一条的时间不是第 1 次
    expect(app.resumeBindLog?.[0].at).not.toBe('2026-03-01T00:00:00.000Z');
  });

  it('重复绑同一个版本 → false，不追加留痕（手抖多点几下不刷屏）', () => {
    const db = freshDB();
    const { versionIds } = seedResume(db);
    const app = makeApp({ resumeVersionId: versionIds[0], resumeVersion: 'v1' });
    db.applications = [app];

    expect(bindResumeVersion(db, app.id, versionIds[0], AT2)).toBe(false);
    expect(app.resumeBindLog ?? []).toHaveLength(0);
    expect(app.updatedAt).toBe('2026-02-20T01:00:00.000Z');
  });

  it('★ 拒绝绑到软删 / 不存在 / 已删简历名下的版本 —— 污染统计的口子从这里堵住', () => {
    const db = freshDB();
    const { versionIds } = seedResume(db, '前端 - 主投', 2);
    softDeleteVersion(db, versionIds[0], AT);
    const app = makeApp();
    db.applications = [app];

    expect(bindResumeVersion(db, app.id, versionIds[0], AT2)).toBe(false); // 软删版本
    expect(bindResumeVersion(db, app.id, 'ver-gone', AT2)).toBe(false); // 不存在
    expect(app.resumeVersionId).toBeUndefined();
    expect(app.resumeBindLog ?? []).toHaveLength(0);
  });

  it('解绑：清 id 与快照、留痕记「已解绑」；本来就未绑定的再解绑是 false', () => {
    const db = freshDB();
    const { versionIds } = seedResume(db);
    const app = makeApp({ resumeVersionId: versionIds[0], resumeVersion: 'v1' });
    const blank = makeApp({ id: 'app-2' });
    db.applications = [app, blank];

    expect(bindResumeVersion(db, app.id, null, AT2)).toBe(true);
    expect(app.resumeVersionId).toBeUndefined();
    expect(app.resumeVersion).toBeUndefined();
    expect(app.resumeBindLog).toEqual([{ label: '已解绑', at: AT2 }]);
    expect(bindResumeVersion(db, blank.id, null, AT2)).toBe(false);
  });

  it('投递不存在或在回收站 → false（回收站里的东西不该被继续改）', () => {
    const db = freshDB();
    const { versionIds } = seedResume(db);
    const trashed = makeApp({ deletedAt: AT2 });
    db.applications = [trashed];

    expect(bindResumeVersion(db, 'app-none', versionIds[0], AT2)).toBe(false);
    expect(bindResumeVersion(db, trashed.id, versionIds[0], AT2)).toBe(false);
    expect(trashed.resumeVersionId).toBeUndefined();
  });
});

describe('绑定与统计的接缝（id 优先，不与 rules.test 的聚合用例重复）', () => {
  it('★ 版本被删后投递上的 id 原样保留（A-12）：悬空引用是统计能「按 id 找回历史」的前提', () => {
    const db = freshDB();
    const { versionIds } = seedResume(db);
    const app = makeApp({ resumeVersionId: versionIds[0], resumeVersion: 'v1' });
    db.applications = [app];

    softDeleteVersion(db, versionIds[0], AT2);
    expect(app.resumeVersionId).toBe(versionIds[0]);
    expect(app.resumeVersion).toBe('v1');
    // 显示侧因此能说出「v1（已删除）」而不是空白
    expect(resolveBoundVersion(db, app).label).toBe('v1（已删除）');
  });

  it('改绑不改变版本的引用计数语义：活投递才计数（回收站里的不算）', () => {
    const db = freshDB();
    const { versionIds } = seedResume(db);
    db.applications = [
      makeApp({ id: 'app-1', resumeVersionId: versionIds[0] }),
      makeApp({ id: 'app-2', resumeVersionId: versionIds[0], deletedAt: AT2 }),
    ];
    const alive = db.applications.filter((item) => !isDeleted(item) && item.resumeVersionId === versionIds[0]);
    expect(alive).toHaveLength(1);
  });
});
