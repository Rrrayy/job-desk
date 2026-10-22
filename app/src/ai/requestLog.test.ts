/**
 * RequestLog 写入侧单测（v0.8 / T03，PRD 验收 13）。
 *
 * 红线断言：日志行**在类型与对象字段层面**就不存在请求/响应原文的位置；
 * 指纹键序无关、内容敏感；上限截断丢最旧。
 * （exportJSON 剥离 requestLog 已在 disaster.test.ts 有回归，不重复。）
 */

import { describe, expect, it } from 'vitest';
import { REQUEST_LOG_LIMIT, buildRequestLogEntry, capRequestLog, fieldsFingerprint } from './requestLog';

const NOW = '2026-10-21T10:00:00.000Z';

describe('requestLog · 字段指纹', () => {
  it('同内容同指纹（键序无关），不同内容必不同', async () => {
    const a = await fieldsFingerprint({ companyName: '字节', jobTitle: '前端', status: '面试中' });
    const b = await fieldsFingerprint({ status: '面试中', jobTitle: '前端', companyName: '字节' });
    const c = await fieldsFingerprint({ companyName: '字节', jobTitle: '前端', status: '已投' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('值差一个字符指纹必变；空对象也有稳定指纹', async () => {
    const a = await fieldsFingerprint({ note: '谢谢' });
    const b = await fieldsFingerprint({ note: '谢谢。' });
    expect(a).not.toBe(b);
    expect(await fieldsFingerprint({})).toBe(await fieldsFingerprint({}));
  });
});

describe('requestLog · 日志行', () => {
  it('日志行只有元数据 + 指纹，没有原文（PRD 验收 13）', () => {
    const entry = buildRequestLogEntry(
      {
        pluginId: 'builtin:d17',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen2.5:7b',
        sentFieldsHash: 'abc123',
        status: 'ok',
      },
      NOW,
    );
    expect(Object.keys(entry).sort()).toEqual([
      'baseUrl',
      'id',
      'model',
      'pluginId',
      'sentFieldsHash',
      'status',
      'timestamp',
    ]);
    expect(entry.id).toMatch(/^rlog_/);
  });

  it('error 日志只带 errorCode，绝不带错误原文', () => {
    const entry = buildRequestLogEntry(
      {
        pluginId: 'builtin:d17',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen2.5:7b',
        sentFieldsHash: 'abc123',
        status: 'error',
        errorCode: 'timeout',
      },
      NOW,
    );
    expect(entry.errorCode).toBe('timeout');
    expect(JSON.stringify(entry)).not.toContain('原文');
  });
});

describe('requestLog · 上限截断', () => {
  it(`超过 ${REQUEST_LOG_LIMIT} 条丢最旧，未超限原样返回`, () => {
    const logs = Array.from({ length: REQUEST_LOG_LIMIT + 10 }, (_, index) =>
      buildRequestLogEntry(
        { pluginId: `p${index}`, baseUrl: 'u', model: 'm', sentFieldsHash: 'h', status: 'ok' },
        NOW,
      ),
    );
    const capped = capRequestLog(logs);
    expect(capped).toHaveLength(REQUEST_LOG_LIMIT);
    expect(capped[0].pluginId).toBe('p10');
    expect(capped[capped.length - 1].pluginId).toBe(`p${REQUEST_LOG_LIMIT + 9}`);

    const small = logs.slice(0, 5);
    expect(capRequestLog(small)).toBe(small);
  });
});
