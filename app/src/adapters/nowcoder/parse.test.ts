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
