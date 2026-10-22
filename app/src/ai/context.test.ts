/**
 * 上下文装配单测（v0.9 / T07）。
 *
 * 盯两条线：
 * 1. buildApplicationContext 与 D15 面板里的旧内联实现**逐字段等价** ——
 *   「搬出来」这一步如果漂了，D15 的话术草稿和 D20 的分析报告就会读到不同的上下文；
 * 2. resumeModules 是**联系方式的结构性边界**：basics 板块根本不产出模块，
 *    字段名集合里断言没有 name/phone/email/city —— 不是「默认不勾」，是「没有勾选框」。
 */

import { describe, expect, it } from 'vitest';
import { buildApplicationContext, modulesText, resumeModules } from './context';
import { emptyContentOf } from '../resume/schema';
import { emptyDB } from '../lib/defaults';
import type { DB } from '../types';

const NOW = '2026-10-21T10:00:00.000Z';

function dbWithResume(): { db: DB; content: ReturnType<typeof emptyContentOf> } {
  const db = emptyDB();
  db.resumes = [
    {
      id: 'res-1',
      name: '主简历',
      templateId: 'tech-single',
      content: emptyContentOf('tech-single'),
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
  return { db, content: db.resumes[0].content };
}

describe('context · resumeModules（模块选择器 + 隐私边界）', () => {
  it('basics 板块不产出模块：字段名集合里没有姓名/电话/邮箱/城市（结构性隐私）', () => {
    const { content } = dbWithResume();
    const basics = content.sections.find((section) => section.type === 'basics');
    if (basics) basics.items[0].fields = { name: '张三', phone: '13800000000', email: 'z@x.com', city: '北京' };
    const experience = content.sections.find((section) => section.type === 'experience');
    if (experience) experience.items[0].fields = { org: '字节跳动' };

    const modules = resumeModules({ templateId: 'tech-single', content });
    const allFieldNames = modules.flatMap((module) => Object.keys(module.fieldPaths));
    expect(modules.map((module) => module.id)).not.toContain(basics?.id);
    for (const banned of ['name', 'phone', 'email', 'city', 'photo']) {
      expect(allFieldNames).not.toContain(banned);
    }
  });

  it('文本行带字段名前缀；month 字段（startMonth/endMonth）不进模块文本', () => {
    const { content } = dbWithResume();
    const experience = content.sections.find((section) => section.type === 'experience');
    if (experience) {
      experience.items[0].fields = { org: '字节跳动', role: '前端实习生', startMonth: '2025-07', endMonth: '2025-12' };
    }
    const modules = resumeModules({ templateId: 'tech-single', content });
    const exp = modules.find((module) => module.id === experience?.id);
    expect(exp).toBeDefined();
    expect(exp?.text).toContain('org: 字节跳动');
    expect(exp?.text).toContain('role: 前端实习生');
    expect(exp?.text).not.toContain('startMonth');
    expect(exp?.text).not.toContain('endMonth');
  });

  it('primaryPath 是润色主字段的全路径（bullets join 为正文），fieldPaths 同步给 JD 定向', () => {
    const { content } = dbWithResume();
    const experience = content.sections.find((section) => section.type === 'experience');
    const item = experience?.items[0];
    if (experience && item) {
      item.fields = { org: '字节跳动' };
      item.bullets = ['负责改写引擎', '压测 QPS +30%'];
    }
    const modules = resumeModules({ templateId: 'tech-single', content });
    const exp = modules.find((module) => module.id === experience?.id);
    expect(exp?.primaryPath).toBe(`s:${experience?.id}:i:${item?.id}:description`);
    expect(exp?.primaryText).toBe('负责改写引擎\n压测 QPS +30%');
    expect(exp?.fieldPaths.description).toBe(exp?.primaryPath);
    expect(exp?.fieldPaths.org).toBe(`s:${experience?.id}:i:${item?.id}:org`);
  });

  it('没有内容的板块不产出模块（空模块只会让用户面对一堆勾不掉的选项）', () => {
    const { content } = dbWithResume();
    const modules = resumeModules({ templateId: 'tech-single', content });
    expect(modules.find((module) => module.id === content.sections.find((s) => s.type === 'awards')?.id)).toBeUndefined();
  });
});

describe('context · modulesText', () => {
  it('【板块名】+ 换行 + 文本，多模块空行分隔', () => {
    const text = modulesText([
      { id: 'a', label: '实习经历', text: 'org: 字节跳动', primaryPath: null, primaryText: '', fieldPaths: {} },
      { id: 'b', label: '专业技能', text: 'skillsText: React', primaryPath: null, primaryText: '', fieldPaths: {} },
    ]);
    expect(text).toBe('【实习经历】\norg: 字节跳动\n\n【专业技能】\nskillsText: React');
  });
});

describe('context · buildApplicationContext（D15 行为等价）', () => {
  it('七个字段与 D15 旧内联实现一字不差（最近一轮 / 最近一条沟通 / 截 200）', () => {
    const db = emptyDB();
    db.companies = [{ id: 'c-1', name: '字节跳动', createdAt: NOW }];
    db.applications = [
      {
        id: 'app-1',
        companyId: 'c-1',
        jobTitle: '前端开发实习生',
        status: 'interviewing',
        statusChangedAt: NOW,
        lastActivityAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    db.interviews = [
      {
        id: 'iv-1',
        applicationId: 'app-1',
        round: 2,
        scheduledAt: '2026-10-20T10:00:00.000Z',
        format: 'onsite',
        interviewer: '王工',
        kind: 'tech',
        result: 'pending',
      },
      {
        id: 'iv-0',
        applicationId: 'app-1',
        round: 1,
        scheduledAt: '2026-10-10T10:00:00.000Z',
        format: 'onsite',
        kind: 'written',
        result: 'pending',
      },
    ];
    db.notes = [
      { id: 'n-1', applicationId: 'app-1', type: 'memo', content: '旧记录', touchedAt: '2026-10-11T00:00:00.000Z' },
      { id: 'n-2', applicationId: 'app-1', type: 'memo', content: '最新沟通：约了二面', touchedAt: '2026-10-19T00:00:00.000Z' },
    ];

    const context = buildApplicationContext(db, db.applications[0]);
    expect(context.companyName).toBe('字节跳动');
    expect(context.jobTitle).toBe('前端开发实习生');
    expect(context.status).toBe('面试中');
    expect(context.round).toBe('第 2 轮');
    expect(context.interviewKind).toBe('技术面');
    expect(context.interviewer).toBe('王工');
    expect(context.lastNote).toBe('最新沟通：约了二面');
  });

  it('没有面试 / 没有记录时兜底为空串（老投递也能直接分析）', () => {
    const db = emptyDB();
    db.companies = [{ id: 'c-1', name: '字节数据不存在时回落', createdAt: NOW }];
    db.applications = [
      {
        id: 'app-1',
        companyId: 'c-404',
        jobTitle: '前端开发实习生',
        status: 'wishlist',
        statusChangedAt: NOW,
        lastActivityAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    const context = buildApplicationContext(db, db.applications[0]);
    expect(context.round).toBe('');
    expect(context.interviewKind).toBe('');
    expect(context.interviewer).toBe('');
    expect(context.lastNote).toBe('');
    expect(context.status).toBe('想投');
  });
});
