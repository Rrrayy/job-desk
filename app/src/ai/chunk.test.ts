/**
 * 分块测试（v0.10 / L2-6）。
 * 三条硬要求：每块不超预算、内容不丢、短文本不被白切。
 */

import { describe, expect, it } from 'vitest';
import { BULK_CHUNK_TOKENS, splitByTokens } from './chunk';
import { estimateTokens } from './budget';

describe('chunk · 分块', () => {
  it('短文本原样返回一个块（不折腾）', () => {
    const text = '一面问了防抖和 Vue 响应式';
    expect(splitByTokens(text)).toEqual([text]);
  });

  it('空文本返回空数组（调用方不用特判空串）', () => {
    expect(splitByTokens('   \n\n  ')).toEqual([]);
  });

  it('每块都不超预算', () => {
    const text = '这是一段面试记录。'.repeat(3000);
    const chunks = splitByTokens(text, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(1000);
    }
  });

  it('内容不丢：所有块拼回去等于原文（忽略空白归一）', () => {
    const text = Array.from({ length: 60 }, (_, i) => `第 ${i} 段：问了项目细节与技术选型，还有手写代码环节。`).join('\n\n');
    const chunks = splitByTokens(text, 300);
    const joined = chunks.join('').replace(/\s+/g, '');
    expect(joined).toBe(text.replace(/\s+/g, ''));
  });

  it('超长单行也能被切开（不会因为一段到底而放弃）', () => {
    const text = '没换行的一段超长记录。'.repeat(2000);
    const chunks = splitByTokens(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(estimateTokens(chunk)).toBeLessThanOrEqual(500);
  });

  it('默认预算就是 4000（改它等于改所有分块行为）', () => {
    expect(BULK_CHUNK_TOKENS).toBe(4000);
  });
});
