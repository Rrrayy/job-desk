import { describe, expect, it } from 'vitest';
import type { InterviewExperience, Question } from '../types';
import { desensitize, markdownFileName, renderExperienceMarkdown, renderManyMarkdown } from './interviewMarkdown';

const experience: InterviewExperience = {
  id: 'exp_1',
  applicationId: 'app_1',
  companyName: '字节跳动',
  jobTitle: '抖音前端',
  round: 2,
  interviewDate: '2025-03-12',
  result: 'failed',
  overallNote: '项目讲太散，深挖到 QPS 就卡住了。',
  source: 'self',
  createdAt: '2025-03-12T10:00:00.000Z',
  updatedAt: '2025-03-12T10:00:00.000Z',
};

const questions: Question[] = [
  {
    id: 'q1',
    experienceId: 'exp_1',
    category: 'algo',
    difficulty: 2,
    text: '手写 `Promise.all`，要求所有失败也返回',
    myAnswer: '只写了全成功分支，reject 直接抛出去了。',
    mastery: 0,
    rootCause: 'conceptGap',
    nextTime: '先写签名 + 空数组边界，再处理 reject。',
    tags: ['手写题'],
    reviewCount: 1,
    createdAt: '2025-03-12T10:00:00.000Z',
    updatedAt: '2025-03-12T10:00:00.000Z',
  },
  {
    id: 'q2',
    experienceId: 'exp_1',
    category: null,
    difficulty: 1,
    text: '团队现在最大的技术债是什么？',
    mastery: 2,
    tags: [],
    reviewCount: 0,
    createdAt: '2025-03-12T10:00:00.000Z',
    updatedAt: '2025-03-12T10:00:00.000Z',
  },
];

describe('Markdown 导出', () => {
  const md = renderExperienceMarkdown(experience, questions, { desensitize: false });

  it('一场面试一个 ## 标题，含公司/岗位/轮次/日期', () => {
    expect(md).toContain('## 字节跳动 · 抖音前端 · 第 2 轮（2025-03-12）');
  });

  it('结果与来源用中文', () => {
    expect(md).toContain('- 结果：未通过');
    expect(md).toContain('`self`');
  });

  it('overallNote 用引用块', () => {
    expect(md).toContain('> 项目讲太散');
  });

  it('每道题一个 ###，并带分类/难度/掌握度', () => {
    expect(md).toContain('### Q1 · 算法 · 难度 2 · 掌握度 0/2');
    expect(md).toContain('### Q2 · 未分类 · 难度 1 · 掌握度 2/2');
  });

  it('空字段整行省略（不输出空的「我当时答：」）', () => {
    const secondBlock = md.split('### Q2')[1];
    expect(secondBlock).not.toContain('我当时答');
    expect(secondBlock).not.toContain('下次：');
  });

  it('标签行只在有标签时出现', () => {
    expect(md).toContain('`标签：手写题`');
    expect(md.split('`标签：').length).toBe(2);
  });

  it('题目顺序 = 录入顺序（不按 mastery 重排）', () => {
    expect(md.indexOf('### Q1')).toBeLessThan(md.indexOf('### Q2'));
  });

  it('多场导出用一级标题聚合', () => {
    const many = renderManyMarkdown(
      [experience, { ...experience, id: 'exp_2', round: 1, interviewDate: '2025-03-05' }],
      new Map([['exp_1', questions]]),
      { desensitize: false },
    );
    expect(many.startsWith('# 字节跳动 面经（2 场）')).toBe(true);
  });

  it('没有面经时给一句引导而不是崩', () => {
    expect(renderManyMarkdown([], new Map(), { desensitize: false })).toContain('还没有可以导出的面经');
  });
});

describe('脱敏', () => {
  it('手机号 / 邮箱', () => {
    const text = desensitize('联系我 13812345678 或 zhangsan@example.com');
    expect(text).not.toContain('13812345678');
    expect(text).toContain('138****0000');
    expect(text).not.toContain('zhangsan@');
  });

  it('薪资数字', () => {
    const text = desensitize('薪资 300元/天，年包 25万');
    expect(text).toContain('<薪资>');
    expect(text).not.toMatch(/\d+元\/天/);
  });

  it('面试官姓名', () => {
    expect(desensitize('张三面试官问得挺细')).toBe('面试官问得挺细');
    expect(desensitize('李四老师很客气')).toBe('面试官很客气');
  });

  it('导出时会应用脱敏', () => {
    const md = renderExperienceMarkdown(
      { ...experience, overallNote: 'HR 说 200元/天，电话 13812345678' },
      [],
      { desensitize: true },
    );
    expect(md).not.toContain('13812345678');
    expect(md).not.toContain('200元/天');
  });
});

/**
 * QA D6 回归集：三种漏掉的写法。
 * 老实现只认「数字 + k/元/万」，所以「200/天」原样漏出；
 * 姓名规则要求 2~3 个汉字，所以单姓的「王面试官」「王老师」也会漏。
 */
describe('脱敏 · 漏网写法（QA D6）', () => {
  it('★ 薪资只带时段单位也要脱（200/天、80/小时、100/月）', () => {
    expect(desensitize('补贴 200/天')).toBe('补贴 <薪资>');
    expect(desensitize('时薪 80/小时')).toBe('时薪 <薪资>');
    expect(desensitize('实习 150 / 天，转正 15k')).toBe('实习 <薪资>，转正 <薪资>');
    expect(desensitize('房补 100/月')).toBe('房补 <薪资>');
  });

  it('薪资各种写法统一抹掉', () => {
    for (const raw of ['200元/天', '15k', '15K', '30万', '8千', '300 元', '30w']) {
      expect(desensitize(`薪资 ${raw} 左右`)).toBe('薪资 <薪资> 左右');
    }
  });

  it('★ 单姓也要脱（王面试官 / 王老师）', () => {
    expect(desensitize('王面试官问得很细')).toBe('面试官问得很细');
    expect(desensitize('王老师人很好')).toBe('面试官人很好');
    expect(desensitize('张三面试官 / 李四老师')).toBe('面试官 / 面试官');
  });

  it('「某总 / 某哥 / 某姐」这类称呼也要脱', () => {
    expect(desensitize('李总说下周给结果')).toBe('某总说下周给结果');
    expect(desensitize('王哥帮我内推的')).toBe('某哥帮我内推的');
    expect(desensitize('赵姐是 HR')).toBe('某姐是 HR');
  });

  it('★ 不许误伤：前端 / 后端 / 一面 / 二面 / 项目 原样保留', () => {
    for (const word of ['前端', '后端', '一面', '二面', '项目', '项目总共三期', '一面二面都问了项目']) {
      expect(desensitize(word)).toBe(word);
    }
    expect(desensitize('一面问项目，二面问前端工程化')).toBe('一面问项目，二面问前端工程化');
    expect(desensitize('这项总结我没答好')).toBe('这项总结我没答好');
  });

  it('导出整篇时同样生效（面经里最常出现的就是这几种写法）', () => {
    const md = renderExperienceMarkdown(
      { ...experience, overallNote: '王老师问的，日薪 200/天，一面问项目' },
      [],
      { desensitize: true },
    );
    expect(md).not.toContain('王老师');
    expect(md).not.toContain('200/天');
    expect(md).toContain('一面问项目');
  });
});

describe('文件名', () => {
  it('公司-岗位-日期-面经.md，且过滤非法字符', () => {
    expect(markdownFileName(experience)).toBe('字节跳动-抖音前端-2025-03-12-面经.md');
    expect(markdownFileName({ ...experience, companyName: 'A/B:C' })).toBe('A-B-C-抖音前端-2025-03-12-面经.md');
  });
});
