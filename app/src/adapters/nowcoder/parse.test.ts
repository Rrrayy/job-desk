import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseNowcoderText } from './parse';

const here = fileURLToPath(new URL('.', import.meta.url));
const text = readFileSync(`${here}fixtures/applications.txt`, 'utf-8');
const NOW = '2025-03-13T12:00:00.000Z';

describe('牛客投递列表解析', () => {
  it('识别出多条记录', () => {
    const result = parseNowcoderText({ text, capturedAt: NOW }, { now: NOW });
    expect(result.records.length).toBeGreaterThanOrEqual(2);
  });

  it('「已面试」这类牛客文案能保留为平台原文', () => {
    const result = parseNowcoderText({ text, capturedAt: NOW }, { now: NOW });
    const tencent = result.records.find((record) => record.companyName === '腾讯');
    expect(tencent?.status).toBe('已面试');
  });
});

describe('牛客详情页解析（2026-10 真机形态）', () => {
  const detail = readFileSync(`${here}fixtures/detail-job.txt`, 'utf-8');
  const NOW2 = '2026-10-21T14:49:00.000Z';
  const result = parseNowcoderText({ text: detail, capturedAt: NOW2 }, { now: NOW2 });

  it('产出恰好一条记录，公司名取自 HR 行首段', () => {
    expect(result.records).toHaveLength(1);
    expect(result.unparsed).toHaveLength(0);
    expect(result.records[0].companyName).toBe('华为HUAWEI');
    expect(result.records[0].jobTitle).toBe('软件开发研发工程师（实习/正式均再招）');
    expect(result.records[0].city).toBe('西安');
    expect(result.records[0].salaryText).toBe('500-1000元/天');
  });

  it('详情页没有联系事件：lastContactAt / status 均留空', () => {
    expect(result.records[0].lastContactAt).toBeUndefined();
    expect(result.records[0].status).toBeUndefined();
  });
});
