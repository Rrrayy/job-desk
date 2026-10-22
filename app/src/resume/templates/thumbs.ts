/**
 * 3 张缩略图（ARCH A-05）—— 8 套模板不写 8 张图，按 `layout` 生成。
 *
 * 为什么是「按布局生成」而不是「一模板一张手绘图」：
 * 1. 体积：8 张手绘 SVG ≈ 8 KB，3 张按布局生成 ≈ 1 KB；
 * 2. 正确性：验收 7 要求「缩略图与成品布局一致」——按 `layout` 生成是**构造上一致**，
 *    不会出现「图画的是双栏、实际渲染成单栏」这种只有用户才发现得了的错。
 *
 * 字节账（每张 ≤1 KB，`templates.test.ts` 逐套断言）：
 * 条形统一走 `<path d>` —— 一条 `M8 26h20v3H8z` 只有 12 字节，
 * 而一个 `<rect>` 要 50+ 字节。3 条 path（深色 / 灰色 / 主题色）扛下全部条形，
 * 这就是「3 张图 ≈ 1 KB」能成立的原因。
 *
 * 颜色只进入缩略图：正文配色由 `.a4--{layout}` 与 `[data-tpl=…]` 的 CSS 决定，
 * 模板之间不许有第二份色板（否则 8 套模板就是 8 份「看起来不一样」的负债）。
 */

import type { Template } from '../../types';

/** 一个矩形：[x, y, 宽, 高] */
type Bar = [number, number, number, number];

/** 把一组矩形拼成**一条** path（首尾相接、每段 z 闭合） */
function pathOf(bars: Bar[]): string {
  return bars.map(([x, y, w, h]) => `M${x} ${y}h${w}v${h}H${x}z`).join('');
}

function styleOf(accent: string): string {
  return `<style>.d{fill:#1b1f2a}.f{fill:#e3e6ee}.a{fill:${accent}}.b{fill:#fff;stroke:#d9dce7}</style>`;
}

const PAPER = '<rect class="b" x="1" y="1" width="58" height="82" rx="2"/>';
/** 头部：深色「姓名」条 + 一条联系方式 */
const HEAD_DARK: Bar[] = [[8, 7, 26, 4]];
const HEAD_GRAY: Bar[] = [[8, 14, 34, 2]];

/**
 * 取一张缩略图。
 *
 * @param layout 布局变体（与 `.a4--{layout}` 一一对应）
 * @param accent 主题色（只用于板块标题条与时间轴圆点，让 8 张卡片在列表里可辨）
 */
export function thumbOf(layout: Template['layout'], accent: string): string {
  // 三个分支都会赋值，所以声明时不写初始值（写了也是死代码）
  let gray: Bar[];
  let mark: Bar[];
  /** 时间轴额外的一段竖导轨（用 path 画，省一个 rect） */
  let rail = '';
  let dots: number[] = [];

  if (layout === 'double') {
    // 左主栏 + 右侧栏：与 `.a4--double` 的两列流一致
    const leftHeads: Bar[] = [[8, 26, 18, 3], [8, 44, 18, 3], [8, 62, 18, 3]];
    const rightHeads: Bar[] = [[40, 26, 10, 3], [40, 44, 10, 3], [40, 62, 10, 3]];
    mark = [...leftHeads, ...rightHeads];
    gray = [
      ...HEAD_GRAY,
      [8, 31, 26, 2], [8, 35, 26, 2], [8, 49, 26, 2], [8, 53, 26, 2], [8, 67, 26, 2],
      [40, 31, 14, 2], [40, 35, 14, 2], [40, 49, 14, 2], [40, 53, 14, 2], [40, 67, 14, 2],
    ];
  } else if (layout === 'timeline') {
    // 左侧竖向时间轴 + 圆点：与 `.a4--timeline` 的导轨一致
    rail = 'M9 26h1.5v44H9z';
    dots = [28, 42, 56, 70];
    mark = [[15, 26, 18, 3], [15, 40, 18, 3], [15, 54, 18, 3], [15, 68, 18, 3]];
    gray = [
      ...HEAD_GRAY,
      [15, 31, 34, 2], [15, 35, 28, 2], [15, 45, 34, 2], [15, 49, 28, 2],
      [15, 59, 34, 2], [15, 63, 28, 2], [15, 73, 34, 2],
    ];
  } else {
    // 单栏：满宽标题 + 满宽正文
    mark = [[8, 26, 20, 3], [8, 42, 20, 3], [8, 58, 20, 3], [8, 74, 20, 3]];
    gray = [
      ...HEAD_GRAY,
      [8, 31, 44, 2], [8, 35, 38, 2],
      [8, 47, 44, 2], [8, 51, 38, 2],
      [8, 63, 44, 2], [8, 67, 38, 2],
      [8, 79, 44, 2],
    ];
  }

  const accentPath = rail + pathOf(mark);
  const dotsSvg = dots.map((cy) => `<circle class="a" cx="9.75" cy="${cy}" r="1.6"/>`).join('');

  // ★ 不写 `xmlns="http://www.w3.org/2000/svg"`：HTML 里内联 SVG 不需要它
  //   （浏览器按标签名进 SVG 命名空间），而它会让「零网络」断言里出现一个假的 http://。
  //   代价是这张图不能单独存成 .svg 打开 —— 它从来不需要单独打开。
  return (
    `<svg viewBox="0 0 60 84" width="60" height="84">${styleOf(accent)}${PAPER}` +
    `<path class="d" d="${pathOf(HEAD_DARK)}"/>` +
    `<path class="f" d="${pathOf(gray)}"/>` +
    `<path class="a" d="${accentPath}"/>${dotsSvg}</svg>`
  );
}
