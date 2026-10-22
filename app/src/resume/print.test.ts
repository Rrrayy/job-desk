// @vitest-environment jsdom
/**
 * 打印编排（L1）。
 *
 * jsdom 只能测「编排」这一层：`window.print` 有没有被调、调了几次、
 * `body[data-printing]` 有没有置位与收回、草稿是不是在打印**之前**落库。
 * 媒体查询在这一层**完全不求值**，所以这里一条 CSS 断言都不写 ——
 * `@media print` 的效果归 `scripts/smoke-print.mjs` 在真浏览器里验（L2）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PAGE_CONTENT_PX,
  PAGE_MARGIN_PX,
  PRINT_CLEANUP_MS,
  PRINT_HINT_LINES,
  PRINT_UNSUPPORTED,
  pageCountOf,
  pageTopPx,
  printResume,
} from './print';

describe('printResume：编排（L1）', () => {
  let printed: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    printed = vi.fn();
    Object.defineProperty(window, 'print', { value: printed, configurable: true, writable: true });
    delete document.body.dataset.printing;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete document.body.dataset.printing;
  });

  it('★ window.print 恰好被调用一次，且打印期间 body[data-printing="1"] 置位', () => {
    vi.useFakeTimers();
    const result = printResume();

    expect(result).toEqual({ ok: true });
    expect(printed).toHaveBeenCalledTimes(1);
    expect(document.body.dataset.printing).toBe('1');

    vi.advanceTimersByTime(PRINT_CLEANUP_MS);
    expect(document.body.dataset.printing).toBeUndefined();
  });

  it('★ afterprint 一到就清理，不必等 300 ms 兜底（两条路径都幂等）', () => {
    vi.useFakeTimers();
    printResume();
    expect(document.body.dataset.printing).toBe('1');

    window.dispatchEvent(new Event('afterprint'));
    expect(document.body.dataset.printing).toBeUndefined();

    // 兜底定时器随后到点也不能报错、不能把状态改回去
    vi.advanceTimersByTime(PRINT_CLEANUP_MS * 2);
    expect(document.body.dataset.printing).toBeUndefined();
    // 监听器已摘掉：再派发一次不会有副作用
    window.dispatchEvent(new Event('afterprint'));
    expect(printed).toHaveBeenCalledTimes(1);
  });

  it('★ 草稿在打印之前落库（否则「屏幕上改了、纸上没改」）', () => {
    const order: string[] = [];
    printed.mockImplementation(() => order.push('print'));
    printResume({ flush: () => order.push('flush') });
    expect(order).toEqual(['flush', 'print']);
  });

  it('window.print 不存在：返回能力错误、不置位、不抛', () => {
    // @ts-expect-error 故意抹掉能力，模拟极老的宿主
    delete window.print;
    const result = printResume();
    expect(result).toEqual({ ok: false, reason: PRINT_UNSUPPORTED });
    expect(document.body.dataset.printing).toBeUndefined();
  });

  it('print 抛错：状态被收回，错误信息带回去（不留一个「永远在打印中」的页面）', () => {
    printed.mockImplementation(() => {
      throw new Error('打印被拦截');
    });
    const result = printResume();
    expect(result).toEqual({ ok: false, reason: '打印被拦截' });
    expect(document.body.dataset.printing).toBeUndefined();
  });

  it('兜底延迟可注入（测试与「立即清理」档位共用同一实现）', () => {
    vi.useFakeTimers();
    printResume({ cleanupDelayMs: 20 });
    expect(document.body.dataset.printing).toBe('1');
    vi.advanceTimersByTime(20);
    expect(document.body.dataset.printing).toBeUndefined();
  });

  it('提示层文案必须说清「另存为 PDF」与缩放（PRD §9-4）', () => {
    expect(PRINT_HINT_LINES).toHaveLength(2);
    expect(PRINT_HINT_LINES[0]).toContain('另存为 PDF');
    expect(PRINT_HINT_LINES[1]).toContain('100%');
  });
});

describe('分页几何：预览与打印共用同一把尺子', () => {
  it('一页可打印高度 = 297mm − 2×14mm = 269mm（@96dpi）', () => {
    expect(PAGE_MARGIN_PX).toBeCloseTo((14 * 96) / 25.4, 6);
    expect(PAGE_CONTENT_PX).toBeCloseTo((269 * 96) / 25.4, 6);
  });

  it('pageCountOf：空/异常 → 1 页；正好一页 → 1；多一点点 → 2', () => {
    expect(pageCountOf(0)).toBe(1);
    expect(pageCountOf(-10)).toBe(1);
    expect(pageCountOf(Number.NaN)).toBe(1);
    expect(pageCountOf(PAGE_CONTENT_PX)).toBe(1);
    expect(pageCountOf(PAGE_CONTENT_PX - 1)).toBe(1);
    expect(pageCountOf(PAGE_CONTENT_PX + 1)).toBe(2);
    expect(pageCountOf(PAGE_CONTENT_PX * 2 + 1)).toBe(3);
  });

  it('pageTopPx：第 1 页内容从 14mm 处开始，之后每页加 269mm', () => {
    expect(pageTopPx(0)).toBeCloseTo(PAGE_MARGIN_PX, 6);
    expect(pageTopPx(1) - pageTopPx(0)).toBeCloseTo(PAGE_CONTENT_PX, 6);
  });
});
