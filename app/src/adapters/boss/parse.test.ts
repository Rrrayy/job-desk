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
