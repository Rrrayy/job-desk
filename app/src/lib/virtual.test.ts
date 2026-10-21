import { describe, expect, it } from 'vitest';
import { computeWindow } from './virtual';

const ROW = 40;

describe('computeWindow', () => {
  it('顶部时从 0 开始，含 overscan', () => {
    const range = computeWindow(1000, 0, 400, ROW, 5);
    expect(range.start).toBe(0);
    // 可视 10 行 + 下方 5 行
    expect(range.end).toBe(15);
    expect(range.padTop).toBe(0);
    expect(range.padBottom).toBe((1000 - 15) * ROW);
  });

  it('滚到中间时上下都有占位', () => {
    const range = computeWindow(1000, 4000, 400, ROW, 5);
    // 4000/40 = 第 100 行
    expect(range.start).toBe(95);
    expect(range.end).toBe(115);
    expect(range.padTop).toBe(95 * ROW);
    expect(range.padBottom).toBe((1000 - 115) * ROW);
  });

  it('滚到底部时 end 恰好等于总数，padBottom 为 0', () => {
    const total = 1000;
    const range = computeWindow(total, (total - 10) * ROW, 400, ROW, 5);
    expect(range.end).toBe(total);
    expect(range.padBottom).toBe(0);
  });

  it('渲染区间永远落在 [0, total] 内', () => {
    for (const scrollTop of [-500, 0, 123, 99999]) {
      const range = computeWindow(50, scrollTop, 400, ROW, 8);
      expect(range.start).toBeGreaterThanOrEqual(0);
      expect(range.end).toBeLessThanOrEqual(50);
      expect(range.start).toBeLessThanOrEqual(range.end);
    }
  });

  it('列表比视口还短时全部渲染', () => {
    const range = computeWindow(3, 0, 400, ROW, 8);
    expect(range.start).toBe(0);
    expect(range.end).toBe(3);
    expect(range.padTop).toBe(0);
    expect(range.padBottom).toBe(0);
  });

  it('行高非法时退化成全渲染，不抛错、不出负数', () => {
    const zero = computeWindow(100, 5000, 400, 0, 5);
    expect(zero).toEqual({ start: 0, end: 100, padTop: 0, padBottom: 0 });
    const negative = computeWindow(100, 5000, 400, -20, 5);
    expect(negative.start).toBe(0);
    expect(negative.end).toBe(100);
  });

  it('总数为 0 时区间为空', () => {
    expect(computeWindow(0, 0, 400, ROW)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });

  it('视口高度为 0（首帧尚未量到）只渲染 overscan 行，不炸', () => {
    const range = computeWindow(1000, 0, 0, ROW, 5);
    expect(range.start).toBe(0);
    expect(range.end).toBe(5);
  });

  it('padTop + 渲染行数 + padBottom 恒等于总高度', () => {
    const total = 777;
    for (const scrollTop of [0, 300, 1500, 8000]) {
      const range = computeWindow(total, scrollTop, 500, ROW, 6);
      const rendered = (range.end - range.start) * ROW;
      expect(range.padTop + rendered + range.padBottom).toBe(total * ROW);
    }
  });
});
