import { describe, expect, it } from 'vitest';
import type { Status } from '../../types';
import { STATUS_RULES, SYNC_STATUS_RANK, mapPlatformStatus } from './statusMap';

describe('状态映射：PRD §B.7 的 9 条全覆盖', () => {
  const cases: Array<[string, Status]> = [
    ['已投递', 'applied'],
    ['简历已送达', 'applied'],
    ['沟通中', 'chatting'],
    ['邀请面试', 'chatting'],
    ['已面试', 'interviewing'],
    ['不合适', 'rejected'],
    ['已录用', 'offer'],
    ['已入职', 'onboarded'],
    ['暂不匹配', 'rejected'],
  ];

  it.each(cases)('「%s」→ %s', (raw, expected) => {
    expect(mapPlatformStatus(raw, {}).status).toBe(expected);
  });

  it('「邀请面试」是高置信度且带 todoInterview 动作，但**绝不**映射成 scheduled', () => {
    const mapped = mapPlatformStatus('邀请面试', {});
    expect(mapped.status).toBe('chatting');
    expect(mapped.status).not.toBe('scheduled');
    expect(mapped.confidence).toBe('high');
    expect(mapped.action).toBe('todoInterview');
  });

  it('「已面试」是中置信度并提示补面试记录', () => {
    const mapped = mapPlatformStatus('已面试', {});
    expect(mapped.status).toBe('interviewing');
    expect(mapped.confidence).toBe('medium');
    expect(mapped.action).toBe('promptInterviewRecord');
  });

  it('认不出来的文案不映射（返回 null，绝不猜）', () => {
    const mapped = mapPlatformStatus('待沟通', {});
    expect(mapped.status).toBeNull();
    expect(mapped.confidence).toBe('low');
    expect(mapped.note).toContain('不认识');
  });

  it('没给状态时也不映射', () => {
    expect(mapPlatformStatus(undefined, {}).status).toBeNull();
    expect(mapPlatformStatus('   ', {}).status).toBeNull();
  });

  it('空白差异不影响匹配', () => {
    expect(mapPlatformStatus('已 投 递', {}).status).toBe('applied');
  });
});

describe('状态映射：用户覆盖', () => {
  it('overrides 优先于内置规则', () => {
    expect(mapPlatformStatus('沟通中', { 沟通中: 'applied' }).status).toBe('applied');
  });

  it('overrides 值为 null = 用户明确要求不映射', () => {
    const mapped = mapPlatformStatus('沟通中', { 沟通中: null });
    expect(mapped.status).toBeNull();
    expect(mapped.note).toContain('不映射');
  });

  it('overrides 键的空白差异也能命中', () => {
    expect(mapPlatformStatus('已 投 递', { 已投递: 'chatting' }).status).toBe('chatting');
  });
});

describe('推进次序 SYNC_STATUS_RANK', () => {
  it('rejected 排在 offer 之后（被拒可能发生在任何阶段）', () => {
    expect(SYNC_STATUS_RANK.rejected).toBeGreaterThan(SYNC_STATUS_RANK.offer);
  });

  it('常规推进顺序单调递增', () => {
    const order: Status[] = ['wishlist', 'applied', 'chatting', 'scheduled', 'interviewing', 'offer', 'onboarded'];
    for (let i = 1; i < order.length; i += 1) {
      expect(SYNC_STATUS_RANK[order[i]]).toBeGreaterThan(SYNC_STATUS_RANK[order[i - 1]]);
    }
  });

  it('9 个状态都有 rank，且互不相同', () => {
    const ranks = Object.values(SYNC_STATUS_RANK);
    expect(ranks).toHaveLength(9);
    expect(new Set(ranks).size).toBe(9);
  });

  it('内置规则顺序即优先级（邀请面试 排在 沟通中 之前）', () => {
    const invite = STATUS_RULES.findIndex((rule) => rule.re.test('邀请面试'));
    const chatting = STATUS_RULES.findIndex((rule) => rule.re.test('沟通中'));
    expect(invite).toBeLessThan(chatting);
  });
});
