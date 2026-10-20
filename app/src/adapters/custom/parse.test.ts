import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCustomText } from './parse';

const here = fileURLToPath(new URL('.', import.meta.url));
const NOW = '2025-03-13T12:00:00.000Z';

describe('custom 兜底解析', () => {
  it('表格形态：一行一条，前两列是公司与岗位', () => {
    const text = readFileSync(`${here}fixtures/table.txt`, 'utf-8');
    const result = parseCustomText({ text, capturedAt: NOW }, { now: NOW });
    expect(result.records).toHaveLength(3);
    expect(result.records[0].companyName).toBe('字节跳动');
    expect(result.records[0].jobTitle).toBe('抖音前端开发实习生');
  });

  it('跳过表头行', () => {
    const text = readFileSync(`${here}fixtures/table.txt`, 'utf-8');
    const result = parseCustomText({ text, capturedAt: NOW }, { now: NOW });
    expect(result.records.some((record) => record.companyName.includes('公司'))).toBe(false);
  });

  it('不是表格时退回通用列表解析', () => {
    const text = ['字节跳动', '抖音前端开发实习生', '沟通中', '3月12日 10:20'].join('\n');
    const result = parseCustomText({ text, capturedAt: NOW }, { now: NOW });
    expect(result.records.length).toBe(1);
    expect(result.records[0].companyName).toBe('字节跳动');
  });

  it('完全认不出的文本进 unparsed，不 throw', () => {
    const result = parseCustomText({ text: '？？？', capturedAt: NOW }, { now: NOW });
    expect(result.records.length + result.unparsed.length).toBeGreaterThan(0);
  });
});
