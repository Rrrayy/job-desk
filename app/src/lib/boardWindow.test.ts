/**
 * 看板窗口化纯函数（v0.9.1 / R-PERF-1，B-11）。
 *
 * 这一层是「渲染 40 张」这条承诺的**唯一可信证明点**：DOM 断言只能证明「这次渲染了
 * 40 张」，证明不了「45 条时窗口真的生效」—— 而 40 条数据时 `slice(0, 40)` 等于全量，
 * 任何错误的实现都会通过。所以窗口的边界必须在纯函数层用 41 / 45 / 80 条来钉。
 */

import { describe, expect, it } from 'vitest';
import {
  BOARD_WINDOW,
  boardWindow,
  boardWindows,
  groupByStatus,
  maxRenderedCards,
  moreCardsLabel,
} from './boardWindow';
import type { Application } from '../types';

const items = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

function app(id: string, status: Application['status']): Application {
  return {
    id,
    companyId: 'c-1',
    jobTitle: `岗位 ${id}`,
    status,
    statusChangedAt: '2026-10-01T00:00:00.000Z',
    lastActivityAt: '2026-10-01T00:00:00.000Z',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

describe('boardWindow', () => {
  it(`窗口大小是 ${BOARD_WINDOW}（架构 Q6 定的数，改它要重新压测）`, () => {
    expect(BOARD_WINDOW).toBe(40);
  });

  it('★★ 45 条：默认只给 40 条、hidden=5、total 仍是 45（列头计数不能用 visible.length）', () => {
    const win = boardWindow(items(45), false);
    expect(win.visible).toHaveLength(40);
    expect(win.visible[0]).toBe(0);
    expect(win.visible[39]).toBe(39);
    expect(win.hidden).toBe(5);
    expect(win.total).toBe(45);
  });

  it('★ 45 条展开后：45 条全给、hidden 归零、total 不变（展开不改变计数口径）', () => {
    const win = boardWindow(items(45), true);
    expect(win.visible).toHaveLength(45);
    expect(win.hidden).toBe(0);
    expect(win.total).toBe(45);
  });

  it('41 条（刚过窗口 1 条）：只少 1 条 —— 边界不多切也不少切', () => {
    const win = boardWindow(items(41), false);
    expect(win.visible).toHaveLength(40);
    expect(win.hidden).toBe(1);
  });

  it('正好 40 条：全量渲染、hidden=0（不出现「还有 0 家」这种噪音）', () => {
    const win = boardWindow(items(40), false);
    expect(win.visible).toHaveLength(40);
    expect(win.hidden).toBe(0);
  });

  it('空列：visible 空、hidden 0、total 0', () => {
    const win = boardWindow([], false);
    expect(win.visible).toEqual([]);
    expect(win.hidden).toBe(0);
    expect(win.total).toBe(0);
  });

  it('size 可注入（测试用小窗口，避免造 40 条数据）', () => {
    const win = boardWindow(items(5), false, 2);
    expect(win.visible).toEqual([0, 1]);
    expect(win.hidden).toBe(3);
    expect(win.total).toBe(5);
  });

  it('size 为 0 / 负数时不越界（返回空 visible，不抛错）', () => {
    expect(boardWindow(items(3), false, 0).visible).toEqual([]);
    expect(boardWindow(items(3), false, -5).visible).toEqual([]);
    expect(boardWindow(items(3), false, 0).hidden).toBe(3);
  });

  it('不修改输入数组（纯函数）', () => {
    const list = items(45);
    boardWindow(list, false);
    expect(list).toHaveLength(45);
  });
});

describe('moreCardsLabel', () => {
  it('hidden > 0 才给文案，且数字是确定的（不是「加载更多」）', () => {
    expect(moreCardsLabel(5)).toBe('还有 5 家 ▾');
    expect(moreCardsLabel(1)).toBe('还有 1 家 ▾');
    expect(moreCardsLabel(0)).toBe('');
    expect(moreCardsLabel(-1)).toBe('');
  });
});

describe('boardWindows / maxRenderedCards / groupByStatus', () => {
  it('boardWindows 按 key 给出各自窗口，展开一列不影响其它列', () => {
    const groups = new Map<string, number[]>([
      ['a', items(45)],
      ['b', items(3)],
    ]);
    const wins = boardWindows(groups, (key) => key === 'a');
    expect(wins.get('a')?.visible).toHaveLength(45);
    expect(wins.get('b')?.visible).toHaveLength(3);
    expect(wins.get('b')?.total).toBe(3);
  });

  it('maxRenderedCards = 列数 × 窗口（渲染量自证用的上限）', () => {
    expect(maxRenderedCards(8)).toBe(320);
    expect(maxRenderedCards(0)).toBe(0);
    expect(maxRenderedCards(8, 10)).toBe(80);
  });

  it('groupByStatus：空列也建桶（列不能因为没数据就消失）', () => {
    const map = groupByStatus([app('a1', 'applied'), app('a2', 'applied'), app('a3', 'offer')], [
      'wishlist',
      'applied',
      'offer',
    ]);
    expect(map.get('wishlist')).toEqual([]);
    expect(map.get('applied')?.map((item) => item.id)).toEqual(['a1', 'a2']);
    expect(map.get('offer')?.map((item) => item.id)).toEqual(['a3']);
    expect(map.size).toBe(3);
  });
});
