/**
 * JD 正文摘要测试（v0.7）。
 *
 * 核心验收来自 PRD-jd-link.md：
 * - 解析只供「采用」，所以每项都要么认得准、要么诚实说认不出；
 * - 公司名认不出不编造；不拿「截止时间」「90 天前更新」凑字段；
 * - 章节抽取只认显式标题行，宁可少抽不可错抽；
 * - jdText 上限 20,000 字符是 UI 拒绝保存的依据，常量必须存在且正确。
 */

import { describe, expect, it } from 'vitest';
import { JD_TEXT_MAX_CHARS, extractJdSections, parseJdText } from './shared';

const NOW = '2026-10-21T08:00:00.000Z';

const BOSS_JD = `Agent 研发实习生
杭州-萧山区
300-310元/天

职位亮点
大模型团队，直接参与 Agent 产品研发

岗位职责
1. 参与 Agent 工作流编排与工具调用链路开发；
2. 与算法同学协作做效果评测。

任职要求
1. 本科及以上在读，每周可实习4天；
2. 熟悉 TypeScript 或 Python。

加分项
有 RAG 或 LangChain 经验者优先。

实习要求
实习3个月以上，尽快到岗。
`;

describe('extractJdSections：只认显式标题行', () => {
  it('抽取职责 / 要求 / 加分项 / 安排四节，行数正确', () => {
    const sections = extractJdSections(BOSS_JD);
    expect(sections.map((section) => section.kind)).toEqual(['duty', 'require', 'bonus', 'arrange']);
    expect(sections[0].lines).toHaveLength(2);
    expect(sections[1].lines).toHaveLength(2);
    expect(sections[3].lines.join('')).toContain('3个月');
  });

  it('标题夹在长句里不认（防止误抽）', () => {
    const sections = extractJdSections('我们希望你有任职要求里列的能力');
    expect(sections).toHaveLength(0);
  });

  it('标题行带冒号也认', () => {
    const sections = extractJdSections('任职要求：\n熟悉 React。');
    expect(sections).toHaveLength(1);
    expect(sections[0].kind).toBe('require');
  });

  it('标题下没有正文不成节', () => {
    const sections = extractJdSections('岗位职责\n任职要求\n熟悉测试。');
    expect(sections).toHaveLength(1);
    expect(sections[0].kind).toBe('require');
  });
});

describe('parseJdText：诚实降级', () => {
  it('BOSS 全文至少识别出岗位/城市/薪资中的两项', () => {
    const digest = parseJdText(BOSS_JD, NOW);
    const record = digest.record;
    expect(record).not.toBeNull();
    const hits = [record?.jobTitle, record?.city, record?.salaryText].filter(Boolean).length;
    expect(hits).toBeGreaterThanOrEqual(2);
  });

  it('线索：每周天数与实习月数', () => {
    const digest = parseJdText(BOSS_JD, NOW);
    expect(digest.hints.daysPerWeek).toBe(4);
    expect(digest.hints.durationMonths).toBe(3);
  });

  it('正文没有「实习」字样时月数不猜', () => {
    const digest = parseJdText('任职要求\n能干6个月。\n岗位职责\n写代码。', NOW);
    expect(digest.hints.durationMonths).toBeUndefined();
  });

  it('登录墙后的半页：没有公司名 → record 为 null + 一句话原因，不编造', () => {
    const digest = parseJdText('岗位职责\n写代码。\n任职要求\n本科。', NOW);
    expect(digest.record).toBeNull();
    expect(digest.reasonText).toBeTruthy();
  });

  it('空文本给可读原因', () => {
    const digest = parseJdText('   \n  ', NOW);
    expect(digest.record).toBeNull();
    expect(digest.reasonText).toContain('空');
  });

  it('不把「90天前更新」「截止时间」当城市或薪资', () => {
    const digest = parseJdText('90天前更新\n申请截止时间 11月30日\n公司信息\n字节跳动', NOW);
    expect(digest.record?.city).toBeUndefined();
    expect(digest.record?.salaryText).toBeUndefined();
  });
});

describe('JD_TEXT_MAX_CHARS', () => {
  it('上限 20,000 字符，UI 据此拒绝保存而不静默截断', () => {
    expect(JD_TEXT_MAX_CHARS).toBe(20_000);
  });
});
