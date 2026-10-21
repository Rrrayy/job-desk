/**
 * 窗口化渲染（v0.5 / D6）。
 *
 * 为什么不引 react-window：它 6KB 起步、带自己的 API 心智，而本项目这里
 * 只需要「给定行高和滚动位置，算出该渲染哪几行」。~80 行纯函数就够了，
 * 而且能进单测（第三方组件的内部行为没法测）。
 *
 * 适用范围：**行高等高**的列表。列表视图是固定行高的 <tr>，正好符合。
 * 若以后要做不等高的（看板卡片），这个 hook 不能直接复用。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface WindowRange {
  /** 起始索引（含） */
  start: number;
  /** 结束索引（不含） */
  end: number;
  /** 上方的占位高度 */
  padTop: number;
  /** 下方的占位高度 */
  padBottom: number;
}

/**
 * 纯函数：算要渲染哪几行。
 *
 * @param total    总行数
 * @param scrollTop 滚动距离（px）
 * @param viewport 可视区高度（px）
 * @param rowHeight 行高（px，必须固定）
 * @param overscan 上下多渲染几行（防止快速滚动时白屏）
 */
export function computeWindow(
  total: number,
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  overscan = 8,
): WindowRange {
  // 行高为 0 或负数时退化成「全渲染」，不能算出负数区间把表格搞崩
  if (rowHeight <= 0 || total <= 0) {
    return { start: 0, end: Math.max(total, 0), padTop: 0, padBottom: 0 };
  }
  const first = Math.floor(Math.max(scrollTop, 0) / rowHeight);
  const visible = Math.ceil(Math.max(viewport, 0) / rowHeight);
  // start 必须夹到 total 以内：滚动条拖到底再回弹、或行数变少时 scrollTop
  // 会临时超出内容高度，不夹就会出现 start > end 的空区间（表格塌成 0 行）
  const start = Math.min(Math.max(0, first - overscan), total);
  const end = Math.min(total, Math.max(start, first + visible + overscan));
  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: Math.max(0, (total - end) * rowHeight),
  };
}

export interface VirtualOptions {
  /** 行高，必须固定 */
  rowHeight: number;
  /** 总行数 */
  count: number;
  /** 超过这个数量才启用窗口化 —— 几十行时全渲染反而更快（少了 scroll 监听与两次重排） */
  threshold?: number;
  overscan?: number;
}

export interface VirtualResult {
  /** false = 数量太少，调用方应该直接全量渲染 */
  enabled: boolean;
  range: WindowRange;
  /** 挂到滚动容器上 */
  onScroll: () => void;
  // React 18 的 LegacyRef 要求 RefObject<T>（不带 null），而 useRef<T|null>(null)
  // 推出的是 RefObject<T|null>，所以这里显式声明成前者的形状
  containerRef: React.RefObject<HTMLDivElement>;
}

/**
 * 列表窗口化。
 *
 * 注意：`onScroll` 用 rAF 节流 —— 直接 setState 会在一次滚动里触发几十次渲染，
 * 而 setState 的渲染比 scroll 事件本身贵得多。
 */
export function useVirtualList(options: VirtualOptions): VirtualResult {
  const { rowHeight, count, threshold = 150, overscan = 8 } = options;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState({ scrollTop: 0, viewport: 0 });
  const frame = useRef<number | null>(null);

  const enabled = count > threshold;

  const measure = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setState((prev) => {
      const next = { scrollTop: el.scrollTop, viewport: el.clientHeight };
      if (prev.scrollTop === next.scrollTop && prev.viewport === next.viewport) return prev;
      return next;
    });
  }, []);

  const onScroll = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null;
      measure();
    });
  }, [measure]);

  // 首次挂载时量一次视口高度（否则第一帧只能渲染 overscan 行）
  useEffect(() => {
    if (!enabled) return;
    measure();
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled, measure]);

  useEffect(
    () => () => {
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    },
    [],
  );

  const range = useMemo(
    () =>
      enabled
        ? computeWindow(count, state.scrollTop, state.viewport, rowHeight, overscan)
        : { start: 0, end: count, padTop: 0, padBottom: 0 },
    [count, enabled, overscan, rowHeight, state.scrollTop, state.viewport],
  );

  return { enabled, range, onScroll, containerRef: containerRef as React.RefObject<HTMLDivElement> };
}
