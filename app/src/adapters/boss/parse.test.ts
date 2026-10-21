import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseBossText } from './parse';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixture = (name: string): string => readFileSync(`${here}fixtures/${name}`, 'utf-8');
const NOW = '2025-03-13T12:00:00.000Z';

const expected = JSON.parse(fixture('expected.json')) as {
  chatList: Array<{ companyName: string; jobTitle: string; status: string }>;
  applyList: Array<{ companyName: string; status: string }>;
  recordList: Array<{
    companyName: string;
    jobTitle: string;
    city: string;
    salaryText: string;
    day: number;
  }>;
  recordCards: Array<{
    companyName: string;
    jobTitle: string;
    city: string;
    salaryText: string;
  }>;
};

describe('BOSS 沟通列表解析', () => {
  it('识别 ≥10 条，且公司/岗位/状态与 expectation 一致', () => {
    const result = parseBossText({ text: fixture('chat-list.txt'), capturedAt: NOW }, { now: NOW });
    expect(result.records.length).toBeGreaterThanOrEqual(10);
    expect(result.records.length).toBe(expected.chatList.length);

    expected.chatList.forEach((wanted, index) => {
      const actual = result.records[index];
      expect(actual.companyName).toBe(wanted.companyName);
      expect(actual.jobTitle).toBe(wanted.jobTitle);
      expect(actual.status).toBe(wanted.status);
      expect(['high', 'medium', 'low']).toContain(actual.overall);
    });
  });

  it('解析失败的那一行必须进 unparsed，不许静默丢', () => {
    const result = parseBossText({ text: fixture('chat-list.txt'), capturedAt: NOW }, { now: NOW });
    expect(result.unparsed.length).toBeGreaterThanOrEqual(1);
    expect(result.records.length + result.unparsed.length).toBeGreaterThanOrEqual(12);
    const reasons = result.unparsed.map((item) => item.reason).join(' ');
    expect(reasons).toContain('公司名');
  });

  it('平台时间解析成 ISO，且不是「抓取时刻」', () => {
    const result = parseBossText({ text: fixture('chat-list.txt'), capturedAt: NOW }, { now: NOW });
    const first = result.records[0];
    expect(first.lastContactAt).toBeDefined();
    expect(Number.isNaN(Date.parse(first.lastContactAt ?? ''))).toBe(false);
    expect(first.lastContactAt).not.toBe(NOW);
    // 3月12日 10:20（本地）→ 与抓取时刻不同一天
    expect(new Date(first.lastContactAt ?? '').getDate()).toBe(12);
  });

  it('已投递列表也能解析，状态原文保留', () => {
    const result = parseBossText({ text: fixture('apply-list.txt'), capturedAt: NOW }, { now: NOW });
    expect(result.records.length).toBe(expected.applyList.length);
    expected.applyList.forEach((wanted, index) => {
      expect(result.records[index].companyName).toBe(wanted.companyName);
      expect(result.records[index].status).toBe(wanted.status);
    });
  });

  it('空文本给出可读的提示', () => {
    const result = parseBossText({ text: '', capturedAt: NOW }, { now: NOW });
    expect(result.records).toHaveLength(0);
    expect(result.unparsed).toHaveLength(1);
    expect(result.unparsed[0].reason).toContain('空');
  });

  it('只有导航按钮的页面（empty.txt）不产出记录', () => {
    const result = parseBossText({ text: fixture('empty.txt'), capturedAt: NOW }, { now: NOW });
    expect(result.records).toHaveLength(0);
    expect(result.unparsed.length).toBeGreaterThanOrEqual(1);
  });

  it('垃圾文本不 throw，且一条都认不出时给出解释', () => {
    const result = parseBossText({ text: fixture('garbage.txt'), capturedAt: NOW }, { now: NOW });
    expect(Array.isArray(result.records)).toBe(true);
    expect(Array.isArray(result.unparsed)).toBe(true);
    expect(result.records.length + result.unparsed.length).toBeGreaterThan(0);
  });
});

describe('BOSS 求职记录页解析（2026-10 真机形态）', () => {
  // 截图拍摄于 2026-10-21；分组日期「10月20日/21日」按注入的 now 补年份
  const RECORD_NOW = '2026-10-21T14:18:00.000Z';

  it('识别全部 3 条，公司名剥离融资与规模', () => {
    const result = parseBossText({ text: fixture('record-list.txt'), capturedAt: RECORD_NOW }, { now: RECORD_NOW });
    expect(result.records.length).toBe(expected.recordList.length);
    expect(result.unparsed.length).toBe(0);

    expected.recordList.forEach((wanted, index) => {
      const actual = result.records[index];
      expect(actual.companyName).toBe(wanted.companyName);
      expect(actual.jobTitle).toBe(wanted.jobTitle);
      expect(actual.city).toBe(wanted.city);
      expect(actual.salaryText).toBe(wanted.salaryText);
    });
  });

  it('分组日期下放到时刻行：跨组日期不都是「今天」', () => {
    const result = parseBossText({ text: fixture('record-list.txt'), capturedAt: RECORD_NOW }, { now: RECORD_NOW });
    const days = result.records.map((record) => new Date(record.lastContactAt ?? '').getDate());
    expect(days).toEqual(expected.recordList.map((wanted) => wanted.day));
    // 带时刻 → 置信度 high
    result.records.forEach((record) => {
      expect(record.confidence.lastContactAt).toBe('high');
    });
  });

  it('沟通过 tab 没有状态行 → status 为空、置信度诚实降为 low', () => {
    const result = parseBossText({ text: fixture('record-list.txt'), capturedAt: RECORD_NOW }, { now: RECORD_NOW });
    result.records.forEach((record) => {
      expect(record.status).toBeUndefined();
      expect(record.confidence.status).toBe('low');
    });
  });

  it('五类计数守恒：新增 + 待归类 === 识别条数', () => {
    const result = parseBossText({ text: fixture('record-list.txt'), capturedAt: RECORD_NOW }, { now: RECORD_NOW });
    expect(result.records.length + result.unparsed.length).toBe(3);
  });
});

describe('BOSS 求职记录卡片解析（2026-10-21 真机形态）', () => {
  // 样例文本（第二例）：卡片头「王芳招聘者」**没有空格**（截图里的空格是
  // 两个 HTML 元素的视觉间隙，innerText 里没有）；方括号城市被拆成
  // 「[ / 城市 / ]」三行；薪资标签无竖线。fixture 按原文逐行还原。
  const CARD_NOW = '2026-10-21T16:00:00.000Z';
  const expectedCard = expected.recordCards;

  it('两张卡片解析成恰好两条记录，卡片头噪声不进任何字段', () => {
    const result = parseBossText({ text: fixture('record-card.txt'), capturedAt: CARD_NOW }, { now: CARD_NOW });
    expect(result.unparsed).toHaveLength(0);
    expect(result.records).toHaveLength(expectedCard.length);

    result.records.forEach((record, index) => {
      expect(record.companyName).toBe(expectedCard[index].companyName);
      expect(record.jobTitle).toBe(expectedCard[index].jobTitle);
      expect(record.city).toBe(expectedCard[index].city);
      expect(record.salaryText).toBe(expectedCard[index].salaryText);
    });
  });

  it('公司名剥离「行业 + 规模」标签（半导体/芯片0-20人，无空格也留不下），只留名字', () => {
    const result = parseBossText({ text: fixture('record-card.txt'), capturedAt: CARD_NOW }, { now: CARD_NOW });
    result.records.forEach((record) => {
      expect(record.companyName).not.toContain('半导体');
      expect(record.companyName).not.toContain('0-20人');
      expect(record.companyName).not.toContain('企业服务');
    });
  });

  it('薪资剥离「在校/应届 本科」标签；招聘者姓名（王芳/陈大明）不进任何字段', () => {
    const result = parseBossText({ text: fixture('record-card.txt'), capturedAt: CARD_NOW }, { now: CARD_NOW });
    const joined = JSON.stringify(result);
    expect(joined).not.toContain('王芳');
    expect(joined).not.toContain('陈大明');
    result.records.forEach((record) => {
      expect(record.salaryText).toBe(record.salaryText?.split(' ')[0]);
    });
  });

  it('卡片没有时间行：lastContactAt 留空而不是猜「今天」，置信度诚实降级', () => {
    const result = parseBossText({ text: fixture('record-card.txt'), capturedAt: CARD_NOW }, { now: CARD_NOW });
    result.records.forEach((record) => {
      expect(record.lastContactAt).toBeUndefined();
      expect(record.status).toBeUndefined();
      expect(record.confidence.status).toBe('low');
    });
  });

  it('带空格的卡片头（「王芳 招聘者」，第一例形态）同样识别', () => {
    const spaced = fixture('record-card.txt').replace('王芳招聘者', '王芳 招聘者').replace('陈大明招聘者', '陈大明 招聘者');
    const result = parseBossText({ text: spaced, capturedAt: CARD_NOW }, { now: CARD_NOW });
    expect(result.unparsed).toHaveLength(0);
    expect(result.records).toHaveLength(2);
    expect(result.records[0].companyName).toBe(expectedCard[0].companyName);
  });
});