/**
 * 证据核对测试（v0.10 / L2-4）。
 * 断言的核心不是「字符串包含」，而是三件事：
 * 编造会被抓、截短会放过、标点/全角/空白差异不该造成误杀。
 */

import { describe, expect, it } from 'vitest';
import { auditEvidence, evidenceSupported, normalizeForMatch } from './evidence';

const SOURCE = '岗位职责：负责字节跳动抖音电商前端开发，要求熟悉 React 18 与 TypeScript，有性能优化经验。';

describe('evidence · 定位规则', () => {
  it('原文逐字命中', () => {
    expect(evidenceSupported('熟悉 React 18 与 TypeScript', SOURCE)).toBe(true);
  });

  it('空白与标点差异不算不同（模型常重新排版）', () => {
    expect(evidenceSupported('熟悉React18与TypeScript', SOURCE)).toBe(true);
    expect(evidenceSupported('熟悉 React 18，与 TypeScript', SOURCE)).toBe(true);
  });

  it('全角字母/数字也能对上', () => {
    expect(evidenceSupported('熟悉 Ｒｅａｃｔ １８', SOURCE)).toBe(true);
  });

  it('模型把长句截短 → 前缀命中', () => {
    expect(evidenceSupported('负责字节跳动抖音电商前端开发', SOURCE)).toBe(true);
  });

  it('编造的句子 → 判无据', () => {
    expect(evidenceSupported('候选人主导过双十一大促架构', SOURCE)).toBe(false);
  });

  it('太短的片段不当作证据（避免「前端」乱命中）', () => {
    expect(evidenceSupported('前端', SOURCE)).toBe(false);
  });

  it('空证据/空来源都是无据', () => {
    expect(evidenceSupported('', SOURCE)).toBe(false);
    expect(evidenceSupported('熟悉 React', '')).toBe(false);
  });

  it('归一化不改变语义，只抹掉排版差异', () => {
    expect(normalizeForMatch(' Ａ b，。c ')).toBe('abc');
  });
});

describe('evidence · 批量核对', () => {
  it('命中的保留证据，不命中的摘掉证据但保留内容', () => {
    const items = [
      { field: 'companyName', value: '字节跳动', evidence: '字节跳动' },
      { field: 'salary', value: '30k', evidence: '月薪三万起' },
    ];
    const result = auditEvidence(items, SOURCE);
    expect(result.unverified).toBe(1);
    expect(result.items[0].evidence).toBe('字节跳动');
    expect(result.items[1].evidence).toBeUndefined();
    // 内容不能因为证据没核实就删掉
    expect(result.items[1].value).toBe('30k');
  });

  it('没有证据的条目原样通过（不是每条建议都有证据）', () => {
    const items: Array<{ field: string; value: string; evidence?: string }> = [{ field: 'city', value: '北京' }];
    const result = auditEvidence(items, SOURCE);
    expect(result.unverified).toBe(0);
    expect(result.items[0]).toEqual({ field: 'city', value: '北京' });
  });

  it('不修改入参（调用方可能还要用原数组）', () => {
    const items = [{ field: 'x', value: 'y', evidence: '编造的证据句子' }];
    auditEvidence(items, SOURCE);
    expect(items[0].evidence).toBe('编造的证据句子');
  });
});
