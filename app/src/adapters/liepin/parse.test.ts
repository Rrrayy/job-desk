import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseLiepinText } from './parse';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixture = (name: string): string => readFileSync(`${here}fixtures/${name}`, 'utf-8');
const NOW = '2026-10-21T14:49:00.000Z';

describe('猎聘详情页解析（2026-10 真机形态）', () => {
  const result = parseLiepinText({ text: fixture('detail-job.txt'), capturedAt: NOW }, { now: NOW });

  it('产出恰好一条记录，公司名来自「公司信息」节', () => {
    expect(result.records).toHaveLength(1);
    expect(result.unparsed).toHaveLength(0);
    expect(result.records[0].companyName).toBe('南京昊控软件技术有限公司');
  });

  it('岗位名与薪资从同一行拆开', () => {
    expect(result.records[0].jobTitle).toBe('C++实习开发工程师');
    expect(result.records[0].salaryText).toBe('100-150元/天');
  });

  it('城市从「南京-秣陵」里取出南京', () => {
    expect(result.records[0].city).toBe('南京');
  });

  it('详情页没有联系事件：lastContactAt / status 均留空（不拿「90天前更新」凑数）', () => {
    expect(result.records[0].lastContactAt).toBeUndefined();
    expect(result.records[0].status).toBeUndefined();
    expect(result.records[0].overall).toBe('low');
  });
});

describe('猎聘投递列表解析（2026-10 真机形态）', () => {
  const list = readFileSync(`${here}fixtures/delivery-list.txt`, 'utf-8');
  const NOW2 = '2026-10-21T15:12:00.000Z';
  const result = parseLiepinText({ text: list, capturedAt: NOW2 }, { now: NOW2 });

  it('恰好一条记录：岗位与薪资从同一行拆开，公司名保留', () => {
    expect(result.records).toHaveLength(1);
    expect(result.records[0].companyName).toBe('华为');
    expect(result.records[0].jobTitle).toBe('【华为实习生招聘】研发工...');
    expect(result.records[0].salaryText).toBe('300-500元/天');
  });

  it('城市、平台时间、状态角标都拿到；Tab 行不污染状态', () => {
    expect(result.records[0].city).toBe('南京');
    expect(new Date(result.records[0].lastContactAt ?? '').getDate()).toBe(11);
    expect(result.records[0].status).toBe('已查看');
    expect(result.records[0].platformStatusText).toBe('已查看');
  });
});
