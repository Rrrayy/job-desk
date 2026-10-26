/**
 * 看板窗口化（v0.9.1 / R-PERF-1，架构 B-11）。
 *
 * ## 为什么是「窗口」而不是「虚拟滚动」
 *
 * 看板的每一列是一个独立的拖拽落点：卡片要能被真实拖起来、真实落进 DOM 里那块区域。
 * 虚拟滚动要靠「占位高度 + 绝对定位」模拟，落点判定会跟着变成几何计算 ——
 * 拖拽、键盘可达、`⋯` 菜单三套交互都要重写一遍，风险远大于收益。
 * 而看板的真实痛点只是「一列 200 张卡时首屏慢」，不是「内容无限长」。
 *
 * 所以取窗口：**每列最多渲染 40 张，其余用一个按钮显式展开**。
 * - 列头计数永远是**真实总数**（不是已渲染数）—— 用户看到「投递中 87」，
 *   点「还有 47 家」就能看到剩下的，数字不会因为窗口而变；
 * - 展开是一次显式动作，`expanded` 由组件本地 state 管（不落库，刷新恢复默认窗口）；
 * - 40 这个数是架构 Q6 定的：一屏 7 列 × 40 ≈ 280 张卡，仍是浏览器一次能同步渲染的量级。
 *
 * ## 为什么不做「首屏 + 滚动加载」
 *
 * 滚动加载会让「一列到底有多少」变成不可知（用户永远滚不到底就不知道还有多少），
 * 而看板的核心语义恰恰是「一眼看清分布」。窗口 + 显式展开保住了这个语义。
 *
 * @module lib/boardWindow
 */

import type { Application } from '../types';

/**
 * 每列默认渲染张数。
 *
 * 40 的来源（架构 Q6）：v0.9 压测里 1 列 40 张 ≈ 5 ms/列同步渲染，
 * 7 列合计仍在两帧内；60 张开始出现可见卡顿，200 张时首屏 > 700 ms。
 */
export const BOARD_WINDOW = 40;

export interface BoardWindow<T> {
  /** 本次要渲染的条目（前 `BOARD_WINDOW` 条，或全部） */
  visible: T[];
  /** 还有多少条没渲染（0 = 不需要「还有 N 家」按钮） */
  hidden: number;
  /** 真实总数 —— **列头计数必须用它**，不能用 `visible.length` */
  total: number;
}

/**
 * 算出一列该渲染哪些条目。
 *
 * 纯函数、无副作用、不依赖 React：窗口规则能被普通单测钉住，
 * 不用起 jsdom 造 45 条数据来验证「到底渲染了几张」。
 *
 * @param list 该列的完整条目（已过滤、已排序）
 * @param expanded 用户是否点过「还有 N 家」（展开后全量渲染）
 * @param size 窗口大小（默认 `BOARD_WINDOW`，测试可注入小值）
 * @returns 要渲染的条目 + 未渲染条数 + 真实总数
 */
export function boardWindow<T>(list: T[], expanded: boolean, size = BOARD_WINDOW): BoardWindow<T> {
  const total = list.length;
  const limit = expanded ? total : Math.min(total, Math.max(0, size));
  return {
    visible: list.slice(0, limit),
    hidden: total - limit,
    total,
  };
}

/**
 * 「还有 N 家」按钮的文案。
 *
 * 说「还有 N 家」而不是「加载更多」：前者的数字是**确定的**（用户知道还剩几家），
 * 后者暗示「后面可能还有更多」。看板要的是可数的分布感。
 *
 * @param hidden 未渲染条数
 * @returns 按钮文案（`hidden <= 0` 时为空串，调用方据此不渲染按钮）
 */
export function moreCardsLabel(hidden: number): string {
  if (hidden <= 0) return '';
  return `还有 ${hidden} 家 ▾`;
}

/**
 * 一次算好所有列的窗口（BoardView 每个 status 一列）。
 *
 * 之所以批量算：组件里逐列调用三次会产生三份 `hidden` 的中间状态，
 * 展开一列时其它列不该跟着重算 —— 一次算清、按 key 取用更不容易错。
 *
 * @param groups status → 该列条目
 * @param isExpanded 某个 status 是否已展开
 * @param size 窗口大小
 * @returns status → 窗口结果
 */
export function boardWindows<T>(
  groups: Map<string, T[]>,
  isExpanded: (key: string) => boolean,
  size = BOARD_WINDOW,
): Map<string, BoardWindow<T>> {
  const out = new Map<string, BoardWindow<T>>();
  for (const [key, list] of groups.entries()) {
    out.set(key, boardWindow(list, isExpanded(key), size));
  }
  return out;
}

/** 看板卡片总数上限（渲染量自证用：超过它就是窗口没生效） */
export function maxRenderedCards(columnCount: number, size = BOARD_WINDOW): number {
  return Math.max(0, columnCount) * Math.max(0, size);
}

/**
 * 便捷：把投递列表按 status 分组（`Application` 专用的小工具，
 * 让 BoardView 的 `byStatus` 与测试共用同一份分组逻辑）。
 *
 * @param apps 可见投递
 * @param statuses 需要建桶的全部状态（保证空列也存在）
 * @returns status → 条目（保持输入顺序）
 */
export function groupByStatus(apps: Application[], statuses: readonly Application['status'][]): Map<string, Application[]> {
  const map = new Map<string, Application[]>();
  for (const status of statuses) map.set(status, []);
  for (const app of apps) {
    const bucket = map.get(app.status);
    if (bucket) bucket.push(app);
  }
  return map;
}
