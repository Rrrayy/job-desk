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
