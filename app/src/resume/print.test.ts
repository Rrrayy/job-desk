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
  PAGE_COLUMNS,
  PAGE_CONTENT_PX,
  PAGE_MARGIN_PX,
  PRINT_CLEANUP_MS,
  PRINT_HINT_LINES,
  PRINT_UNSUPPORTED,
  pageCountOf,
  pageTopPx,
  paginate,
  paginateColumns,
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

describe('paginate：模拟「块被整块推下页」（预览页数必须等于打印页数）', () => {
  // 用 1000 当一页，数字好算；真实值由 A4Preview 传 PAGE_CONTENT_PX
  const PAGE = 1000;
  const of = (blocks: { top: number; height: number }[]) => paginate(blocks, PAGE);

  it('全都放得下一整页 → 零断点、1 页', () => {
    const result = of([{ top: 0, height: 400 }, { top: 400, height: 400 }]);
    expect(result.breaks).toEqual([]);
    expect(result.pages).toBe(1);
    expect(result.height).toBe(800);
  });

  it('★ 块跨过页线 → 整块推下页，断点落在页线处', () => {
    // 第 2 块从 900 开始、高 300：900+300 > 1000 → 推到 1000，尾巴落在 1300
    const result = of([{ top: 0, height: 900 }, { top: 900, height: 300 }]);
    expect(result.breaks).toEqual([1000]);
    expect(result.height).toBe(1300);
    expect(result.pages).toBe(2);
  });

  it('推块会顺延后面的块（累计位移），断点因此不等距', () => {
    // 块 1 占 0..900，块 2 占 900..1200（跨线 → 推 100，offset=100），
    // 块 3 原本 1200..2100，被顺延成 1300..2200 —— 于是又跨 2000，再推一次（offset=800）
    const result = of([
      { top: 0, height: 900 },
      { top: 900, height: 300 },
      { top: 1200, height: 900 },
    ]);
    expect(result.breaks).toEqual([1000, 2000]);
    expect(result.pages).toBe(3);
  });

  it('顺延后刚好落在页尾的块不再被推（位移只影响后续，不影响自己是否超界）', () => {
    // 块 3 被推到 1300 起、高 600 → 1900 收尾，没碰到 2000，所以只有一个断点
    const result = of([
      { top: 0, height: 900 },
      { top: 900, height: 300 },
      { top: 1200, height: 600 },
    ]);
    expect(result.breaks).toEqual([1000]);
    expect(result.pages).toBe(2);
  });

  it('★ 页数按「推块后的流总长」算，不是「断点个数 + 1」', () => {
    // 只有 2 个断点，但末块被推到 2000 起、2500 收尾 → 真的占了 3 页
    // （这正是「预览说 2 页、打印 3 页」的来源：拿断点个数推页数会少算一页）
    const result = of([
      { top: 0, height: 950 },
      { top: 950, height: 900 }, // 跨 1000 → 推到 1000..1900
      { top: 1850, height: 650 }, // 顺延到 1900 起、跨 2000 → 再推到 2000..2650
    ]);
    expect(result.breaks).toEqual([1000, 2000]);
    expect(result.height).toBe(2650);
    expect(result.pages).toBe(3);
  });

  it('正好卡在页线上（不越界）不算跨页，不产生多余分页线', () => {
    const result = of([{ top: 0, height: 600 }, { top: 600, height: 400 }]);
    expect(result.breaks).toEqual([]);
    expect(result.pages).toBe(1);
  });

  it('★ 超过一整页的块不推块，但它跨过的页线要逐条记下（浏览器只能切开它）', () => {
    // 0..2500：跨 1000 与 2000 → 3 页。推块毫无意义（推过去还是放不下）
    const result = of([{ top: 0, height: 2500 }]);
    expect(result.breaks).toEqual([1000, 2000]);
    expect(result.pages).toBe(3);
  });

  it('超高块之后的块从它的尾巴继续排（不会退回第一页）', () => {
    const result = of([{ top: 0, height: 1500 }, { top: 1500, height: 200 }]);
    expect(result.breaks).toEqual([1000]);
    expect(result.height).toBe(1700);
    expect(result.pages).toBe(2);
  });

  it('高度 0 的块（隐藏板块）被跳过，不影响断点', () => {
    const result = of([{ top: 0, height: 0 }, { top: 0, height: 500 }]);
    expect(result.breaks).toEqual([]);
    expect(result.pages).toBe(1);
  });

  it('空文档 → 无断点（1 页）', () => {
    const result = of([]);
    expect(result.breaks).toEqual([]);
    expect(result.height).toBe(0);
    expect(result.pages).toBe(1);
  });
});

describe('paginateColumns：分栏版式（每页并排 2 栏）', () => {
  const PAGE = 1000;

  it('板面不足一页高 → 1 页、零断点', () => {
    const result = paginateColumns(800, PAGE);
    expect(result.pages).toBe(1);
    expect(result.breaks).toEqual([]);
    expect(result.height).toBe(800);
  });

  it('★ 页数 = 板面高 ÷ 一页高（栏数上下约掉，与栏宽无关）', () => {
    // 板面 1472px（两栏各 1472 高，总内容 2944px），一页装 2×1000 → 2 页
    expect(paginateColumns(1472, PAGE).pages).toBe(2);
    expect(paginateColumns(2500, PAGE).pages).toBe(3);
    expect(paginateColumns(1000, PAGE).pages).toBe(1);
    expect(paginateColumns(1001, PAGE).pages).toBe(2);
  });

  it('断点是等距的（分栏没有「整块推下页」的累积位移）', () => {
    expect(paginateColumns(2500, PAGE).breaks).toEqual([1000, 2000]);
  });

  it('量不到高度（0 / NaN）→ 当作 1 页，不产生 NaN 断点', () => {
    expect(paginateColumns(0, PAGE)).toEqual({ breaks: [], height: 0, pages: 1 });
    expect(paginateColumns(Number.NaN, PAGE).pages).toBe(1);
  });

  it('栏数常量就是双栏模板的实际栏数（.a4--double 的 column-count）', () => {
    expect(PAGE_COLUMNS).toBe(2);
  });
});
