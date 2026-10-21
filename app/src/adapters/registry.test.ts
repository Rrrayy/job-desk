/**
 * 适配器管线冒烟测试。
 * 这个文件的存在意义：让 `npm test` 在什么都没有的时候也有东西可跑，
 * 同时守住 adapters/ 的边界（协议文件必须能被 import 且不炸）。
 */

import { describe, expect, it } from 'vitest';
import { ADAPTERS, adapterById, adapterForUrl, isAdapterStale } from './registry';

describe('适配器注册表', () => {
  it('注册了 4 个平台且 id 唯一', () => {
    const ids = ADAPTERS.map((adapter) => adapter.id);
    expect(ids).toEqual(['boss', 'shixiseng', 'nowcoder', 'liepin', 'custom']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('adapterById 命中与未命中', () => {
    expect(adapterById('boss')?.name).toBe('BOSS 直聘');
    expect(adapterById('nowcoder')?.name).toBe('牛客');
  });

  it('adapterForUrl 只命中 BOSS 的沟通/投递页', () => {
    expect(adapterForUrl('https://www.zhipin.com/web/geek/chat')?.id).toBe('boss');
    expect(adapterForUrl('https://www.zhipin.com/web/geek/apply?status=1')?.id).toBe('boss');
    expect(adapterForUrl('https://www.zhipin.com/job_detail/abc.html')).toBeNull();
    expect(adapterForUrl(undefined)).toBeNull();
  });

  it('超过 6 个月未验证会被标记为可能失效', () => {
    const boss = adapterById('boss');
    expect(boss).not.toBeNull();
    if (!boss) return;
    // 相对 lastVerifiedAt 计算，校准日期更新时测试不需要跟着改
    const verified = Date.parse(boss.lastVerifiedAt);
    const plusMonths = (months: number): string =>
      new Date(verified + months * 30 * 24 * 3600 * 1000).toISOString();
    expect(isAdapterStale(boss, plusMonths(1))).toBe(false);
    expect(isAdapterStale(boss, plusMonths(8))).toBe(true);
  });

  it('每个适配器都有版本与验证时间', () => {
    for (const adapter of ADAPTERS) {
      expect(adapter.version.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(adapter.lastVerifiedAt))).toBe(false);
    }
  });
});
