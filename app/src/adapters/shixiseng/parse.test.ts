import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseShixisengText } from './parse';

const here = fileURLToPath(new URL('.', import.meta.url));
const text = readFileSync(`${here}fixtures/delivery-list.txt`, 'utf-8');
const NOW = '2025-03-13T12:00:00.000Z';

describe('实习僧投递列表解析', () => {
  it('识别出多条记录，公司名与岗位名都在', () => {
    const result = parseShixisengText({ text, capturedAt: NOW }, { now: NOW });
    expect(result.records.length).toBeGreaterThanOrEqual(3);
    expect(result.records[0].companyName).toBe('字节跳动');
    expect(result.records[0].jobTitle).toBe('抖音前端开发实习生');
  });

  it('状态原文与时间都拿到了', () => {
    const result = parseShixisengText({ text, capturedAt: NOW }, { now: NOW });
    expect(result.records[0].status).toBe('已投递');
    expect(result.records[0].lastContactAt).toBeDefined();
  });

  it('空文本不 throw', () => {
    const result = parseShixisengText({ text: '', capturedAt: NOW }, { now: NOW });
    expect(result.records).toHaveLength(0);
    expect(result.unparsed.length).toBeGreaterThan(0);
  });
});

describe('实习僧详情页解析（2026-10 真机形态）', () => {
  const detail = readFileSync(`${here}fixtures/detail-job.txt`, 'utf-8');
  const NOW2 = '2026-10-21T14:49:00.000Z';
  const result = parseShixisengText({ text: detail, capturedAt: NOW2 }, { now: NOW2 });

  it('产出恰好一条记录：云南省医药 / 软件工程师实习生', () => {
    expect(result.records).toHaveLength(1);
    expect(result.unparsed).toHaveLength(0);
    expect(result.records[0].companyName).toBe('云南省医药');
    expect(result.records[0].jobTitle).toBe('软件工程师实习生');
    expect(result.records[0].salaryText).toBe('80-120/天');
  });

  it('截止时间 2026-12-31 是投递窗口，绝不写进 lastContactAt', () => {
    expect(result.records[0].lastContactAt).toBeUndefined();
    expect(result.records[0].status).toBeUndefined();
  });
});
