/**
 * token 估算测试（v0.10 / L1-9）。
 * 断言的是「量级正确」而不是「精确等于」—— 估算器不是分词器，
 * 但它必须区分得开「中文 1000 字」和「英文 1000 字符」，否则预警线没有意义。
 */

import { describe, expect, it } from 'vitest';
import { CONTEXT_WARN_TOKENS, estimateMessagesTokens, estimateTokens, isContextHeavy } from './budget';

describe('budget · token 估算', () => {
  it('空文本是 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('中文按 1 字 ≈ 1 token', () => {
    const text = '面'.repeat(1000);
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(1000);
    expect(estimateTokens(text)).toBeLessThan(1100);
  });

  it('英文按 3–4 字符 ≈ 1 token（1000 字符远小于 1000）', () => {
    const text = 'a'.repeat(1000);
    expect(estimateTokens(text)).toBeGreaterThan(250);
    expect(estimateTokens(text)).toBeLessThan(350);
  });

  it('同样字符数，中文估算显著高于英文（这正是按字符截断的漏洞）', () => {
    expect(estimateTokens('中'.repeat(500))).toBeGreaterThan(estimateTokens('a'.repeat(500)) * 2);
  });

  it('多行文本不会因为换行被算成 0', () => {
    expect(estimateTokens('\n\n\n')).toBeGreaterThan(0);
  });

  it('system 与 user 都计入（不能只算用户输入）', () => {
    const system = { role: 'system' as const, content: '你是助手' };
    const user = { role: 'user' as const, content: '你好' };
    const onlyUser = estimateTokens(user.content);
    expect(estimateMessagesTokens([system, user])).toBeGreaterThan(onlyUser);
  });

  it('预警线：4000 不报，8000 报', () => {
    expect(isContextHeavy(4000)).toBe(false);
    expect(isContextHeavy(CONTEXT_WARN_TOKENS)).toBe(true);
    expect(isContextHeavy(20_000)).toBe(true);
  });
});
