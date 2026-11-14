/**
 * 模块二 · 公司五字段清洗 + 档案聚合（PRD §3.2 COM-1 ~ COM-6）。
 *
 * 两条口径在这里钉死：
 * 1. **空字段不产生行** —— 界面上不许出现「规模：—」这种占位；
 * 2. **员工口碑 ≠ 面试体感** —— 合成一个字段的结果是用户永远只填一种。
 */

import { describe, expect, it } from 'vitest';
import type {
  Application,
  Company,
  DB,
  Interview,
  InterviewExperience,
  Note,
  Question,
} from '../../types';
import { emptyDB } from '../defaults';
import {
  COMPANY_STAGES,
  COMPANY_STAGE_LABEL,
  companyFullLabel,
  companyOverviewRows,
  normalizeCompanyExtras,
} from './fields';
import { companyDossierOf, sameNameCompanies } from './dossier';

const NOW = new Date(2026, 10, 1, 9, 0, 0);
const NOW_ISO = NOW.toISOString();

function makeCompany(id: string, name: string, overrides: Partial<Company> = {}): Company {
  return { id, name, createdAt: '2026-09-01T00:00:00.000Z', ...overrides };
}

function makeApp(id: string, companyId: string, overrides: Partial<Application> = {}): Application {
  return {
    id,
    companyId,
    jobTitle: `岗位 ${id}`,
    status: 'interviewing',
    statusChangedAt: NOW_ISO,
    lastActivityAt: NOW_ISO,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

function makeNote(id: string, applicationId: string, overrides: Partial<Note> = {}): Note {
  return {
    id,
    applicationId,
    type: 'chat',
    content: `备注 ${id}`,
    touchedAt: NOW_ISO,
    ...overrides,
  };
}

function makeInterview(id: string, applicationId: string, overrides: Partial<Interview> = {}): Interview {
  return {
    id,
    applicationId,
    round: 1,
    scheduledAt: NOW_ISO,
    format: 'video',
    result: 'pending',
    ...overrides,
  };
}

function makeExperience(
  id: string,
  companyName: string,
  overrides: Partial<InterviewExperience> = {},
): InterviewExperience {
  return {
    id,
    companyName,
    interviewDate: '2026-10-01',
    result: 'passed',
    source: 'self',
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

function makeQuestion(id: string, experienceId: string, mastery: 0 | 1 | 2): Question {
  return {
    id,
    experienceId,
    category: 'algo',
    difficulty: 3,
    text: `题目 ${id}`,
    mastery,
    tags: [],
    reviewCount: 0,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
}

describe('公司五字段清洗', () => {
  it('融资阶段是 7 值枚举，每个值都有中文标签', () => {
    expect(COMPANY_STAGES).toEqual(['angel', 'a', 'b', 'c', 'd', 'listed', 'unknown']);
    for (const stage of COMPANY_STAGES) expect(COMPANY_STAGE_LABEL[stage]).toBeTruthy();
    expect(COMPANY_STAGE_LABEL.unknown).toBe('查过没查到');
  });

  it('★ 全空 → 返回空对象（不写 scale:"" 这种空串占位）', () => {
    expect(normalizeCompanyExtras(undefined)).toEqual({});
    expect(normalizeCompanyExtras({})).toEqual({});
    expect(normalizeCompanyExtras({ scale: '   ', website: '' })).toEqual({});
  });

  it('五个字段都认，且去首尾空格', () => {
    expect(
      normalizeCompanyExtras({
        scale: ' 1000-9999人 ',
        financingStage: 'b',
        website: ' https://example.com ',
        industryDetail: ' 短视频 ',
        employeeReview: ' 加班多但成长快 ',
      }),
    ).toEqual({
      scale: '1000-9999人',
      financingStage: 'b',
      website: 'https://example.com',
      industryDetail: '短视频',
      employeeReview: '加班多但成长快',
    });
  });

  it('★ 官网只放行 http(s)：脏协议挡在写库前（它会被渲染成 <a href>）', () => {
    expect(normalizeCompanyExtras({ website: 'javascript:alert(1)' })).toEqual({});
    expect(normalizeCompanyExtras({ website: 'example.com' })).toEqual({});
    expect(normalizeCompanyExtras({ website: 'HTTP://example.com' })).toEqual({
      website: 'HTTP://example.com',
    });
  });

  it('非法融资阶段丢弃（不猜成 unknown）', () => {
    expect(normalizeCompanyExtras({ financingStage: 'e' })).toEqual({});
    expect(normalizeCompanyExtras({ financingStage: '已上市' })).toEqual({});
  });

  it('长文本按字段上限截断：规模 40 / 官网 200 / 行业细分 40 / 口碑 300', () => {
    const extras = normalizeCompanyExtras({
      scale: '规'.repeat(60),
      website: `https://${'a'.repeat(300)}`,
      industryDetail: '行'.repeat(60),
      employeeReview: '口'.repeat(400),
    });
    expect(extras.scale).toHaveLength(40);
    expect(extras.website).toHaveLength(200);
    expect(extras.industryDetail).toHaveLength(40);
    expect(extras.employeeReview).toHaveLength(300);
  });
});

describe('companyOverviewRows · 空字段不产生行', () => {
  it('只有名字的公司 → 一行都没有', () => {
    expect(companyOverviewRows(makeCompany('c1', '字节跳动'))).toEqual([]);
  });

  it('简称与全名相同 → 不重复占一行', () => {
    const rows = companyOverviewRows(makeCompany('c1', '字节跳动', { shortName: '字节跳动' }));
    expect(rows).toEqual([]);
  });

  it('★ 员工口碑与面试体感是两行两个标签（合并会让用户以为是一回事）', () => {
    const rows = companyOverviewRows(
      makeCompany('c1', '字节跳动', {
        impression: '面试官很客气',
        employeeReview: '加班多但成长快',
      }),
    );
    expect(rows).toEqual([
      { label: '面试体感', value: '面试官很客气' },
      { label: '员工口碑', value: '加班多但成长快' },
    ]);
  });

  it('顺序按「用户读一家公司的顺序」，融资阶段翻成中文，官网带 href', () => {
    const rows = companyOverviewRows(
      makeCompany('c1', '字节跳动', {
        shortName: '字节',
        industry: '互联网',
        industryDetail: '短视频',
        scale: '10000 人以上',
        financingStage: 'listed',
        website: 'https://example.com',
        city: '北京',
        referrer: '张三',
        impression: '两轮技术面',
        employeeReview: '食堂不错',
      }),
    );
    expect(rows.map((row) => row.label)).toEqual([
      '简称',
      '行业',
      '行业细分',
      '规模',
      '融资阶段',
      '官网',
      '城市',
      '内推人',
      '面试体感',
      '员工口碑',
    ]);
    expect(rows.find((row) => row.label === '融资阶段')?.value).toBe('已上市');
    expect(rows.find((row) => row.label === '官网')?.href).toBe('https://example.com');
  });

  it('companyFullLabel：有简称写「全名（简称）」，没有就只写全名', () => {
    expect(companyFullLabel(makeCompany('c1', '字节跳动', { shortName: '字节' }))).toBe(
      '字节跳动（字节）',
    );
    expect(companyFullLabel(makeCompany('c1', '字节跳动'))).toBe('字节跳动');
    expect(companyFullLabel(makeCompany('c1', '字节跳动', { shortName: '  ' }))).toBe('字节跳动');
  });
});

describe('companyDossierOf · 档案聚合', () => {
  function buildDB(): DB {
    const db = emptyDB();
    db.companies = [
      makeCompany('c1', '字节跳动', { shortName: '字节' }),
      makeCompany('c2', '美团'),
    ];
    db.applications = [
      makeApp('a1', 'c1', { jobTitle: '抖音前端', status: 'rejected', deletedAt: null }),
      makeApp('a2', 'c1', { jobTitle: '飞书前端', status: 'offer' }),
      makeApp('a3', 'c2', { jobTitle: '美团后端' }),
      makeApp('a4', 'c1', { jobTitle: '已删掉的岗位', deletedAt: '2026-10-30T00:00:00.000Z' }),
    ];
    db.notes = [
      makeNote('n1', 'a1', { touchedAt: '2026-10-01T10:00:00.000Z', type: 'chat' }),
      makeNote('n2', 'a1', {
        touchedAt: '2026-10-05T10:00:00.000Z',
        type: 'system',
        auto: true,
        content: '状态推进到「面试中」',
      }),
      // 指向已删除投递：不该进时间轴
      makeNote('n3', 'a4', { touchedAt: '2026-10-06T10:00:00.000Z' }),
      // 别的公司：不该进
      makeNote('n4', 'a3', { touchedAt: '2026-10-07T10:00:00.000Z' }),
    ];
    db.interviews = [
      makeInterview('iv1', 'a1', { round: 2, scheduledAt: '2026-10-03T14:00:00.000Z', result: 'failed' }),
      makeInterview('iv2', 'a3', { scheduledAt: '2026-10-04T14:00:00.000Z' }),
    ];
    return db;
  }

  it('公司不存在 → null（调用方不渲染抽屉）', () => {
    expect(companyDossierOf(buildDB(), 'c-missing', NOW)).toBeNull();
  });

  it('★ 已删除的投递及其子记录一律不计入（删了还看得见是最伤信任的 bug）', () => {
    const dossier = companyDossierOf(buildDB(), 'c1', NOW);
    if (!dossier) throw new Error('档案不该为空');
    expect(dossier.applications.map((row) => row.app.id)).toEqual(['a1', 'a2']);
    expect(dossier.timeline.map((entry) => entry.id)).not.toContain('n3');
  });

  it('时间轴 = notes + interviews，倒序排列，system note 不加类型前缀', () => {
    const dossier = companyDossierOf(buildDB(), 'c1', NOW);
    if (!dossier) throw new Error('档案不该为空');
    expect(dossier.timeline.map((entry) => entry.id)).toEqual(['n2', 'iv1', 'n1']);
    expect(dossier.timeline[0].text).toBe('状态推进到「面试中」');
    expect(dossier.timeline[1].text).toBe('第 2 轮面试 · 已挂');
    expect(dossier.timeline[2].text).toContain('备注 n1');
    // 每条都带岗位标签（三个岗位混在一起时这一列不能省）
    expect(dossier.timeline.every((entry) => entry.jobLabel.length > 0)).toBe(true);
  });

  it('小计：投递数 / 面过几家 / 已挂 / Offer', () => {
    const dossier = companyDossierOf(buildDB(), 'c1', NOW);
    if (!dossier) throw new Error('档案不该为空');
    expect(dossier.stats.applications).toBe(2);
    expect(dossier.stats.interviewed).toBe(1);
    expect(dossier.stats.rejected).toBe(1);
    expect(dossier.stats.offer).toBe(1);
  });

  it('hasOffer 跟着 Application.offer 走（投递状态是 rejected 也算拿到过 offer）', () => {
    const db = buildDB();
    db.applications[0].offer = { monthlySalary: 20000, updatedAt: NOW_ISO };
    const dossier = companyDossierOf(db, 'c1', NOW);
    if (!dossier) throw new Error('档案不该为空');
    expect(dossier.applications[0].hasOffer).toBe(true);
    expect(dossier.applications[1].hasOffer).toBe(false);
  });

  it('面试行按时间倒序，带岗位名', () => {
    const dossier = companyDossierOf(buildDB(), 'c1', NOW);
    if (!dossier) throw new Error('档案不该为空');
    expect(dossier.interviews.map((row) => row.interview.id)).toEqual(['iv1']);
    expect(dossier.interviews[0].jobTitle).toBe('抖音前端');
  });

  it('★ 面经按公司名精确命中（含简称）+ 挂在这家公司投递上的两种口径都收', () => {
    const db = buildDB();
    db.experiences = [
      makeExperience('e1', '字节跳动'),
      makeExperience('e2', '字节'),
      makeExperience('e3', '某家不相干的公司', { applicationId: 'a1' }),
      makeExperience('e4', '美团'),
    ];
    db.questions = [
      makeQuestion('q1', 'e1', 0),
      makeQuestion('q2', 'e1', 2),
      makeQuestion('q3', 'e3', 0),
      makeQuestion('q4', 'e4', 0),
    ];
    const dossier = companyDossierOf(db, 'c1', NOW);
    if (!dossier) throw new Error('档案不该为空');
    expect(dossier.experience.total).toBe(3);
    expect(dossier.experience.unmastered).toBe(2);
    // 题库跳转用原始 companyName，保证两边数字同口径
    expect([...dossier.experienceNames].sort()).toEqual(['字节', '字节跳动', '某家不相干的公司']);
  });

  it('没有任何笔记 / 面试 / 面经也不崩：时间轴为空、平均沉默 0', () => {
    const db = emptyDB();
    db.companies = [makeCompany('c1', '空壳公司')];
    const dossier = companyDossierOf(db, 'c1', NOW);
    if (!dossier) throw new Error('档案不该为空');
    expect(dossier.timeline).toEqual([]);
    expect(dossier.stats).toEqual({
      applications: 0,
      interviewed: 0,
      rejected: 0,
      offer: 0,
      avgSilenceDays: 0,
    });
    expect(dossier.experience).toEqual({ total: 0, unmastered: 0 });
  });
});

describe('sameNameCompanies · 只提示不合并', () => {
  function db(): DB {
    const base = emptyDB();
    base.companies = [
      makeCompany('c1', '字节跳动'),
      makeCompany('c2', '字节跳动科技'),
      makeCompany('c3', '美团'),
    ];
    return base;
  }

  it('归一化后同名 → 命中（「科技」这种后缀会被剥掉）', () => {
    expect(sameNameCompanies(db(), '字节跳动').map((item) => item.id)).toEqual(['c1', 'c2']);
  });

  it('排除自身（编辑自己时不该提示「和自己重名」）', () => {
    expect(sameNameCompanies(db(), '字节跳动', 'c1').map((item) => item.id)).toEqual(['c2']);
  });

  it('空名字 / 归一化后为空 → 空结果（不误报）', () => {
    expect(sameNameCompanies(db(), '  ')).toEqual([]);
  });

  it('全角与空格不影响判定', () => {
    const base = emptyDB();
    base.companies = [makeCompany('c1', 'ＢＹＴＥＤＡＮＣＥ（北京）')];
    expect(sameNameCompanies(base, 'bytedance北京').map((item) => item.id)).toEqual(['c1']);
  });
});

/* ============ v1.0.0 · COM-1 的点名场景：3 岗位 / 5 条 note / 2 场面试 → 时间轴 7 条 ============ */

describe('COM-1 · 一家公司 3 个岗位、5 条 note、2 场面试 → 时间轴 7 条', () => {
  it('★ 条目数 = 5 + 2（system note 也计入），每条带岗位标签，已删投递及其子记录不计', () => {
    const db = emptyDB();
    db.companies = [makeCompany('c1', '字节跳动', { shortName: '字节' })];
    db.applications = [
      makeApp('a1', 'c1', { jobTitle: '抖音前端' }),
      makeApp('a2', 'c1', { jobTitle: '飞书前端' }),
      makeApp('a3', 'c1', { jobTitle: '商业化产品' }),
      // 已删除的第 4 个岗位：它的 note / 面试一律不许进档案
      makeApp('a4', 'c1', { jobTitle: '已删岗位', deletedAt: '2026-10-31T00:00:00.000Z' }),
    ];
    db.notes = [
      makeNote('n1', 'a1', { touchedAt: '2026-10-01T10:00:00.000Z' }),
      makeNote('n2', 'a1', { touchedAt: '2026-10-02T10:00:00.000Z', type: 'system', auto: true, content: '状态：已沟通 → 面试中' }),
      makeNote('n3', 'a2', { touchedAt: '2026-10-03T10:00:00.000Z' }),
      makeNote('n4', 'a3', { touchedAt: '2026-10-04T10:00:00.000Z', type: 'followup' }),
      makeNote('n5', 'a3', { touchedAt: '2026-10-05T10:00:00.000Z' }),
      makeNote('n6', 'a4', { touchedAt: '2026-10-06T10:00:00.000Z' }),
    ];
    db.interviews = [
      makeInterview('iv1', 'a1', { round: 2, scheduledAt: '2026-10-07T14:00:00.000Z' }),
      makeInterview('iv2', 'a2', { round: 1, scheduledAt: '2026-10-08T14:00:00.000Z' }),
      makeInterview('iv3', 'a4', { scheduledAt: '2026-10-09T14:00:00.000Z' }),
    ];

    const dossier = companyDossierOf(db, 'c1', NOW);
    if (!dossier) throw new Error('档案不该为空');
    expect(dossier.applications).toHaveLength(3);
    expect(dossier.timeline).toHaveLength(7);
    expect(dossier.timeline.map((entry) => entry.id)).toEqual(['iv2', 'iv1', 'n5', 'n4', 'n3', 'n2', 'n1']);
    // 每条都带岗位标签（三个岗位混在一起时不带标签会读成一条）
    expect(dossier.timeline.every((entry) => entry.jobLabel.length > 0)).toBe(true);
    expect(dossier.timeline.map((entry) => entry.jobLabel)).toEqual([
      '飞书前端',
      '抖音前端',
      '商业化产品',
      '商业化产品',
      '飞书前端',
      '抖音前端',
      '抖音前端',
    ]);
    // 已删投递的两条子记录都不在
    expect(dossier.timeline.map((entry) => entry.id)).not.toContain('n6');
    expect(dossier.timeline.map((entry) => entry.id)).not.toContain('iv3');
  });
});
