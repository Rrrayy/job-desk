/**
 * 简历与版本生命周期的回归（T05 的数据侧）。
 *
 * 这里测的每一条都对应一个「用户会真的心疼」的场景，而不是「函数返回了对的东西」：
 * - 冻结的版本被后续编辑改写 → 用户三周后打开「投出去的那一版」，发现内容和现在一样；
 * - 切模板丢字段 → 用户以为点错了，反复切回来又切回去；
 * - 删版本顺手清了投递绑定 → 投递记录上「当时投的哪份」永久消失（A-12 明确禁止）；
 * - 撤销把别的东西一起退了 → 用户不敢再用 ⌘Z。
 */

import { describe, expect, it } from 'vitest';
import type { DB, ResumeContent } from '../types';
import { emptyDB } from '../lib/defaults';
import { applyResumeSlice, activeVersionsOf, createResume, duplicateResume, nextVersionLabel, purgeResume, purgeVersion, referencingApplications, renameResume, renameVersion, restoreResume, restoreVersion, saveVersion, setPrimaryVersion, snapshotResumes, softDeleteResume, softDeleteVersion, switchTemplate, adoptVersionAsDraft, VERSION_LIMIT, VERSION_WARN_AT, versionLabelFor, versionQuotaHint, versionQuotaUsed, versionsOf } from './versions';
import { ensureSections, setField } from './schema';
import { TEMPLATE_ORDER, sectionsOf } from './templates';
import { uid } from '../lib/util';

const AT = '2026-03-01T10:00:00.000Z';

function freshDB(): DB {
  return emptyDB();
}

/** 造一份有内容的草稿（直接改 content，不走 UI） */
function fillName(db: DB, resumeId: string, name: string): void {
  const resume = db.resumes.find((item) => item.id === resumeId)!;
  const basics = resume.content.sections.find((section) => section.type === 'basics')!;
  resume.content = setField(resume.content, basics.id, basics.items[0].id, 'name', name);
}

/** 连续存 n 个版本（label 自动，内容每次不同） */
function seedVersions(db: DB, resumeId: string, n: number): void {
  for (let index = 1; index <= n; index += 1) {
    fillName(db, resumeId, `第 ${index} 版`);
    const result = saveVersion(db, resumeId, '', `2026-03-${String(index).padStart(2, '0')}T00:00:00.000Z`);
    expect(result.ok).toBe(true);
  }
}

describe('createResume / duplicateResume', () => {
  it('新建：内容按模板补齐（板块齐全、字段全空），不是一张空表单', () => {
    const db = freshDB();
    const resume = createResume(db, { name: '前端 - 主投', templateId: 'campus-general', at: AT });

    expect(db.resumes).toHaveLength(1);
    expect(resume.name).toBe('前端 - 主投');
    expect(resume.templateId).toBe('campus-general');
    expect(resume.content.sections.map((s) => s.type)).toEqual(
      sectionsOf('campus-general').map((s) => s.type),
    );
    for (const section of resume.content.sections) expect(section.items).toHaveLength(1);
    expect(resume.deletedAt).toBeNull();
  });

  it('新建：名字留空给「未命名简历」，不写空串（空名字在列表里是一行看不见的东西）', () => {
    const db = freshDB();
    expect(createResume(db, { name: '   ', templateId: 'tech-single', at: AT }).name).toBe('未命名简历');
  });

  it('★ 复制：content 深拷贝（改副本不影响源）、**不带版本历史**', () => {
    const db = freshDB();
    const source = createResume(db, { name: '源', templateId: 'tech-single', at: AT });
    seedVersions(db, source.id, 2);
    const nameOf = (id: string): string =>
      db.resumes
        .find((item) => item.id === id)!
        .content.sections.find((s) => s.type === 'basics')!.items[0].fields.name;
    const before = nameOf(source.id);

    const copy = duplicateResume(db, source.id, AT)!;
    expect(copy.name).toBe('源 副本');
    expect(versionsOf(db, copy.id)).toHaveLength(0);
    expect(versionsOf(db, source.id)).toHaveLength(2);
    // 副本拿到的是深拷贝：内容一样，但不是同一份
    expect(nameOf(copy.id)).toBe(before);

    // 改副本 → 源不受影响
    fillName(db, copy.id, '改过的副本');
    expect(nameOf(copy.id)).toBe('改过的副本');
    expect(nameOf(source.id)).toBe(before);
  });

  it('复制不存在的简历 → null（不造一条半残记录）', () => {
    const db = freshDB();
    expect(duplicateResume(db, 'nope', AT)).toBeNull();
  });
});

describe('renameResume / switchTemplate', () => {
  it('改名：空名 / 同名都不算改动（返回 false，调用方据此不入撤销栈）', () => {
    const db = freshDB();
    const resume = createResume(db, { name: 'A', templateId: 'tech-single', at: AT });
    expect(renameResume(db, resume.id, '   ', AT)).toBe(false);
    expect(renameResume(db, resume.id, 'A', AT)).toBe(false);
    expect(renameResume(db, resume.id, 'B', AT)).toBe(true);
    expect(db.resumes[0].name).toBe('B');
  });

  it('★ 切模板：A → B → A，内容一条不丢（超集语义）', () => {
    const db = freshDB();
    const resume = createResume(db, { name: 'A', templateId: 'tech-single', at: AT });
    fillName(db, resume.id, '林一舟');
    const before = db.resumes[0].content.sections.length;

    expect(switchTemplate(db, resume.id, 'campus-general', AT)).toBe(true);
    // 大学版多了 campus/courses 等板块
    expect(db.resumes[0].content.sections.length).toBeGreaterThanOrEqual(before);
    const afterA = switchTemplate(db, resume.id, 'tech-single', AT);
    expect(afterA).toBe(true);

    const name = db.resumes[0].content.sections
      .find((s) => s.type === 'basics')!
      .items[0].fields.name;
    expect(name).toBe('林一舟');
    // 切回来之后 content 是超集：大学版补出来的板块还在
    const types = db.resumes[0].content.sections.map((s) => s.type);
    expect(types).toContain('campus');
  });

  it('模板没变 → false（不产生一个「什么都没改」的撤销点）', () => {
    const db = freshDB();
    const resume = createResume(db, { name: 'A', templateId: 'tech-single', at: AT });
    expect(switchTemplate(db, resume.id, 'tech-single', AT)).toBe(false);
  });
});

describe('saveVersion：冻结', () => {
  it('★ 冻结是深拷贝：之后改草稿，版本里还是当时的内容', () => {
    const db = freshDB();
    const resume = createResume(db, { name: 'A', templateId: 'tech-single', at: AT });
    fillName(db, resume.id, '投出去的名字');
    const result = saveVersion(db, resume.id, '投出去的那一版', AT);
    expect(result.ok).toBe(true);

    fillName(db, resume.id, '后来改成这样');
    const version = versionsOf(db, resume.id)[0];
    const frozenName = version.content.sections.find((s) => s.type === 'basics')!.items[0].fields.name;
    expect(frozenName).toBe('投出去的名字');
    expect(version.label).toBe('投出去的那一版');
    expect(version.templateId).toBe('tech-single');
  });

  it('标签留空自动 v1 / v2（按含已删的条数推，不会重名）', () => {
    const db = freshDB();
    const resume = createResume(db, { name: 'A', templateId: 'tech-single', at: AT });
    const first = saveVersion(db, resume.id, '', AT);
    expect(first.ok && first.label).toBe('v1');
    expect(nextVersionLabel(db, resume.id)).toBe('v2');
  });

  it('★ 第 30 个还能存，第 31 个硬拒并给原因（Q12：只提示不拦，满额才拒）', () => {
    const db = freshDB();
    const resume = createResume(db, { name: 'A', templateId: 'tech-single', at: AT });
    seedVersions(db, resume.id, VERSION_LIMIT);
    expect(activeVersionsOf(db, resume.id)).toHaveLength(VERSION_LIMIT);

    const rejected = saveVersion(db, resume.id, '', AT);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.reason).toContain(String(VERSION_LIMIT));
    expect(activeVersionsOf(db, resume.id)).toHaveLength(VERSION_LIMIT);
  });

  it('满额提示：第 27 个不显示，第 28 个开始显示（Q12 的时机）', () => {
    const db = freshDB();
    const resume = createResume(db, { name: 'A', templateId: 'tech-single', at: AT });
    seedVersions(db, resume.id, VERSION_WARN_AT - 1);
    expect(versionQuotaHint(db, resume.id)).toBeNull();

    seedVersions(db, resume.id, 1);
    expect(versionQuotaHint(db, resume.id)).toBe(
      `已 ${VERSION_WARN_AT}/${VERSION_LIMIT}，满了需要先删旧版本`,
    );
  });

  it('软删的版本不占名额（否则用户删了还是加不进去，等于死结）', () => {
    const db = freshDB();
    const resume = createResume(db, { name: 'A', templateId: 'tech-single', at: AT });
    seedVersions(db, resume.id, 2);
    const target = versionsOf(db, resume.id)[0];
    softDeleteVersion(db, target.id, AT);
    expect(versionQuotaUsed(db, resume.id)).toBe(1);
    expect(saveVersion(db, resume.id, '', AT).ok).toBe(true);
  });

  it('简历不存在 → ok:false（不凭空造一个孤儿版本）', () => {
    const db = freshDB();
    const result = saveVersion(db, 'nope', '', AT);
    expect(result.ok).toBe(false);
    expect(db.resumeVersions).toHaveLength(0);
  });
});

describe('主版本 / 改名 / 软删 / 恢复 / 真删', () => {
  it('★ 设主版本指向已软删的版本 → 拒绝（主版本不能指向回收站里的东西）', () => {
    const db = freshDB();
    const resume = createResume(db, { name: 'A', templateId: 'tech-single', at: AT });
    seedVersions(db, resume.id, 2);
    const [newest, older] = versionsOf(db, resume.id);

    expect(setPrimaryVersion(db, older.id)).toBe(true);
    expect(db.settings.defaultResumeVersionId).toBe(older.id);

    softDeleteVersion(db, older.id, AT);
    expect(setPrimaryVersion(db, older.id)).toBe(false);
    expect(db.settings.defaultResumeVersionId).toBeUndefined();
    expect(newest.id).not.toBe(older.id);
  });

  it('改名版本：id 不变、空名不算改动', () => {
    const db = freshDB();
    const resume = createResume(db, { name: 'A', templateId: 'tech-single', at: AT });
    seedVersions(db, resume.id, 1);
    const version = versionsOf(db, resume.id)[0];
    expect(renameVersion(db, version.id, '  ')).toBe(false);
    expect(renameVersion(db, version.id, 'v1 前端-项目版')).toBe(true);
    expect(versionsOf(db, resume.id)[0].id).toBe(version.id);
    expect(versionsOf(db, resume.id)[0].label).toBe('v1 前端-项目版');
  });

  it('恢复版本：回到活着的列表，但**不自动**恢复主版本指针（那是另一个决定）', () => {
    const db = freshDB();
    const resume = createResume(db, { name: 'A', templateId: 'tech-single', at: AT });
    seedVersions(db, resume.id, 1);
    const version = versionsOf(db, resume.id)[0];
    setPrimaryVersion(db, version.id);
    softDeleteVersion(db, version.id, AT);
    expect(restoreVersion(db, version.id)).toBe(true);
    expect(db.settings.defaultResumeVersionId).toBeUndefined();
    expect(activeVersionsOf(db, resume.id)).toHaveLength(1);
  });

  it('★ 真删版本不动投递绑定（A-12：悬空是设计的一部分，清空才是数据损失）', () => {
    const db = freshDB();
    const resume = createResume(db, { name: 'A', templateId: 'tech-single', at: AT });
    seedVersions(db, resume.id, 1);
    const version = versionsOf(db, resume.id)[0];
    const app = { id: 'app_1', resumeVersionId: version.id, deletedAt: null } as DB['applications'][number];
    db.applications.push(app);

    softDeleteVersion(db, version.id, AT);
    expect(referencingApplications(db, version.id).map((a) => a.id)).toEqual(['app_1']);
    expect(purgeVersion(db, version.id)).toBe(true);
    // 引用还在（悬空 id），这正是 A-12 要的：删版本不该顺手删掉「当时投的哪份」
    expect(db.applications[0].resumeVersionId).toBe(version.id);
    expect(referencingApplications(db, version.id)).toHaveLength(1);
  });

  it('版本被真删后，显示名退回投递上的快照名并标「已删除」', () => {
    const db = freshDB();
    const resume = createResume(db, { name: 'A', templateId: 'tech-single', at: AT });
    seedVersions(db, resume.id, 1);
    const version = versionsOf(db, resume.id)[0];
    renameVersion(db, version.id, 'v1 前端');
    purgeVersion(db, version.id);
    // 真实用法：投递上存着当时名字的快照（`resumeVersion`），版本没了就靠它说话
    expect(versionLabelFor(db, version.id, 'v1 前端')).toBe('v1 前端（已删除）');
    // 连快照都没有（很老的数据）也不能空白
    expect(versionLabelFor(db, version.id)).toBe('已删除的版本（已删除）');
    expect(versionLabelFor(db, undefined)).toBe('未绑定');
  });

  it('引用计数只算活着（未软删）的投递', () => {
    const db = freshDB();
    const resume = createResume(db, { name: 'A', templateId: 'tech-single', at: AT });
    seedVersions(db, resume.id, 1);
    const version = versionsOf(db, resume.id)[0];
    db.applications.push({ id: 'a1', resumeVersionId: version.id, deletedAt: null } as DB['applications'][number]);
    db.applications.push({ id: 'a2', resumeVersionId: version.id, deletedAt: AT } as DB['applications'][number]);
    expect(referencingApplications(db, version.id).map((a) => a.id)).toEqual(['a1']);
  });
});

describe('adoptVersionAsDraft：冻结版本 → 草稿', () => {
  it('★ 深拷贝、版本一个字节不动、templateId 一起带过来', () => {
    const db = freshDB();
    const resume = createResume(db, { name: 'A', templateId: 'creative', at: AT });
    fillName(db, resume.id, '冻结时的名字');
    saveVersion(db, resume.id, 'creative 版', AT);
    const version = versionsOf(db, resume.id)[0];
    const frozenSnapshot = JSON.stringify(version.content);

    // 草稿改成别的样子 + 换模板
    fillName(db, resume.id, '现在的名字');
    switchTemplate(db, resume.id, 'tech-single', AT);

    expect(adoptVersionAsDraft(db, version.id, AT)).toBe(true);
    const live = db.resumes[0];
    expect(live.templateId).toBe('creative');
    const name = live.content.sections.find((s) => s.type === 'basics')!.items[0].fields.name;
    expect(name).toBe('冻结时的名字');
    // 版本自己被回写了吗？没有
    expect(JSON.stringify(versionsOf(db, resume.id)[0].content)).toBe(frozenSnapshot);
  });

  it('草稿与版本不共享引用（改草稿不会改到版本）', () => {
    const db = freshDB();
    const resume = createResume(db, { name: 'A', templateId: 'tech-single', at: AT });
    saveVersion(db, resume.id, 'v1', AT);
    const version = versionsOf(db, resume.id)[0];
    adoptVersionAsDraft(db, version.id, AT);
    fillName(db, resume.id, '改草稿');
    const versionName = version.content.sections.find((s) => s.type === 'basics')!.items[0].fields.name;
    expect(versionName ?? '').toBe('');
  });

  it('指向已软删的版本 → false（回收站里的东西不能当草稿源）', () => {
    const db = freshDB();
    const resume = createResume(db, { name: 'A', templateId: 'tech-single', at: AT });
    seedVersions(db, resume.id, 1);
    const version = versionsOf(db, resume.id)[0];
    softDeleteVersion(db, version.id, AT);
    expect(adoptVersionAsDraft(db, version.id, AT)).toBe(false);
  });
});

describe('简历软删 / 恢复 / 真删', () => {
  it('软删进回收站、恢复回来；真删连带清掉它名下所有版本', () => {
    const db = freshDB();
    const resume = createResume(db, { name: 'A', templateId: 'tech-single', at: AT });
    seedVersions(db, resume.id, 3);

    expect(softDeleteResume(db, resume.id, AT)).toBe(true);
    expect(db.resumes[0].deletedAt).toBe(AT);
    expect(restoreResume(db, resume.id)).toBe(true);
    expect(db.resumes[0].deletedAt).toBeNull();

    softDeleteVersion(db, versionsOf(db, resume.id)[0].id, AT);
    expect(purgeResume(db, resume.id)).toBe(true);
    expect(db.resumes).toHaveLength(0);
    expect(db.resumeVersions).toHaveLength(0);
  });
});

describe('撤销快照：只回滚简历那三块', () => {
  it('★ 往返一致：快照 → 改 → 贴回去 = 原样，且不碰别的表', () => {
    const db = freshDB();
    const resume = createResume(db, { name: 'A', templateId: 'tech-single', at: AT });
    seedVersions(db, resume.id, 2);
    db.questions.push({
      id: uid('q'),
      experienceId: 'exp_1',
      text: '一道题',
      mastery: 0,
      category: null,
      difficulty: 2,
      tags: [],
      reviewCount: 0,
      createdAt: AT,
      updatedAt: AT,
    });

    const snapshot = snapshotResumes(db);
    const before = JSON.stringify({ resumes: db.resumes, versions: db.resumeVersions });

    seedVersions(db, resume.id, 2);
    adoptVersionAsDraft(db, versionsOf(db, resume.id)[0].id, AT);
    expect(JSON.stringify({ resumes: db.resumes, versions: db.resumeVersions })).not.toBe(before);

    applyResumeSlice(db, snapshot);
    expect(JSON.stringify({ resumes: db.resumes, versions: db.resumeVersions })).toBe(before);
    // 题库（别的表）从头到尾没被动过
    expect(db.questions).toHaveLength(1);
  });

  it('快照是深拷贝：贴回去之后再改库，快照本身不变（否则撤销栈会被后来的操作污染）', () => {
    const db = freshDB();
    const resume = createResume(db, { name: 'A', templateId: 'tech-single', at: AT });
    const snapshot = snapshotResumes(db);
    const frozen = JSON.stringify(snapshot.resumes);
    renameResume(db, resume.id, '改名了', AT);
    expect(JSON.stringify(snapshot.resumes)).toBe(frozen);
  });
});

describe('内容形状：所有模板都吃得下', () => {
  it('新建 → 冻结 → 以此版本为草稿，在 8 套模板上都成立', () => {
    for (const templateId of TEMPLATE_ORDER) {
      const db = freshDB();
      const resume = createResume(db, { name: templateId, templateId, at: AT });
      const filled: ResumeContent = ensureSections(resume.content, templateId);
      db.resumes[0].content = filled;
      const saved = saveVersion(db, resume.id, '', AT);
      expect(saved.ok).toBe(true);
      expect(adoptVersionAsDraft(db, versionsOf(db, resume.id)[0].id, AT)).toBe(true);
      expect(db.resumes[0].content.sections.length).toBeGreaterThan(0);
    }
  });
});
