/**
 * 打印编排（ARCH §1.1 / §1.5 · 唯一路径 `window.print()`）。
 *
 * 为什么「生成 PDF」这件事在本版被彻底否决：PDF 库最小也有几十上百 KB，
 * `@react-pdf/renderer` 还必须动态 `import`（= 网络请求 = 破零网络铁律）。
 * 而浏览器的「另存为 PDF」与预览共用同一份 DOM、同一套 mm CSS ——
 * 一致性最高的方案恰好也是体积最小的方案。
 *
 * 这个文件只做一件事：把「打印」这个有多步副作用的动作收成一个函数，
 * 顺序错一步就会出用户可见的问题：
 *
 * 1. **先 flush 草稿**（A-07）：最后一次输入可能还在 400 ms 防抖窗口里，
 *    不 flush 就会「屏幕上改了、纸上没改」。
 * 2. **置 `body.dataset.printing`**：`@media print` 的隐藏规则靠这个属性限定作用域，
 *    否则「打印当前页」以外的场景也会被摘掉顶栏。
 * 3. **`window.print()` 恰一次**：调用两次会弹两次对话框（旧 Firefox 会）。
 * 4. **清理必须幂等**：`afterprint` 与 300 ms 兜底定时器会竞争，
 *    两条路径都要能安全地把状态收回去（Safari 某些版本不派发 afterprint）。
 *
 * 零 React、零全局状态 —— jsdom 里换掉 `win` / `doc` 就能整段测。
 */

/** 打印提示层的第一行（PRD §9-4：多余设置会让分页错乱） */
export const PRINT_HINT_LINES = [
  '在打印对话框里把「目标打印机」选成『另存为 PDF』',
  '缩放选『默认』或『100%』，页边距交给纸张设置 —— 改这些会让分页错乱',
] as const;

/** `window.print` 不存在时的兜底文案（一行内联，不弹窗：R-AI-5 同款口径） */
export const PRINT_UNSUPPORTED = '当前浏览器不支持打印';

/** `afterprint` 没来时的兜底清理延迟（ARCH §7.2） */
export const PRINT_CLEANUP_MS = 300;

/**
 * 页边距（mm）：**全仓唯一一份**，`@page { margin: 14mm }` 与预览的 `.a4__body` 内边距
 * 都从这里取值（CSS 里是字面量，注释指向本常量）。Q4 裁决：静态 14mm，模板差异走内边距。
 */
export const PAGE_MARGIN_MM = 14;

/** 96dpi 是 CSS 的 px 定义（1in = 96px），所以这些换算不依赖设备 */
const MM_TO_PX = 96 / 25.4;

/** 页边距（px） */
export const PAGE_MARGIN_PX = PAGE_MARGIN_MM * MM_TO_PX;

/**
 * 一页的**可打印**高度（px）：A4 高 297mm − 上下 @page 边距 2×14mm = 269mm。
 *
 * 这是「预览里画分页线」与「打印时真实翻页」共用的同一把尺子 ——
 * 只要它同时出现在 CSS（@page margin）和这里，两边就不可能各算各的。
 */
export const PAGE_CONTENT_PX = (297 - 2 * PAGE_MARGIN_MM) * MM_TO_PX;

/** 内容高度 → 页数（空内容也算 1 页；epsilon 吸收子像素抖动） */
export function pageCountOf(heightPx: number): number {
  if (!Number.isFinite(heightPx) || heightPx <= 0) return 1;
  return Math.max(1, Math.ceil(heightPx / PAGE_CONTENT_PX - 1e-6));
}

/**
 * 第 index 页（0 基）顶部在**屏幕连续流**里的 y 坐标（px）。
 *
 * 为什么是这个公式：打印时每一页都是「14mm 边距 + 269mm 内容」，
 * 而屏幕上是「一次 14mm + 连续内容」—— 所以第 i 页内容的起点落在
 * `14mm + i × 269mm` 处。分页线画在这里，线与内容才对得上。
 */
export function pageTopPx(index: number): number {
  return PAGE_MARGIN_PX + index * PAGE_CONTENT_PX;
}

/** 连续流里的一个块：距内容起点多高（top）、占多高（height，**含**下外边距） */
export interface FlowBlock {
  top: number;
  height: number;
}

/** 一次模拟分页的结果 */
export interface Pagination {
  /** 每页在连续流里的断开位置（相对内容起点的 CSS px，升序） */
  breaks: number[];
  /** 推块之后的**流总长**（≥ 各块自然堆叠高度之和）—— 页数由它决定，不是由断点个数决定 */
  height: number;
  /** 页数（≥1） */
  pages: number;
}

/**
 * 模拟一次分页，返回断开位置与推块后的流总长。
 *
 * 为什么需要这一步（T04 实测发现的真问题）：预览是连续流，而打印会分页。
 * `break-inside: avoid` 的块如果正好卡在纸张边界上，浏览器会**整块推到下一页** ——
 * 这一推会让后面的内容整体顺延，最终页数可能比「总高度 ÷ 269mm」多一页。
 * 只按总高度估页数的结果是：预览显示 2 页、打印出来 3 页（门禁第一次跑就抓到了）。
 *
 * 算法就是浏览器分页的极简版：顺序扫描，块放不下当前页剩余空间就整体推到下一页。
 *
 * 两条容易写错的细节：
 * - **页数必须由「推块之后的流总长」算，不能由「断点个数 + 1」算**：
 *   最后一块被推下去之后，它的尾巴可能已经跨到下一页去了（这一页只装下上半截）。
 * - **比一页还高的块**：`break-inside: avoid` 也救不了，浏览器只能切开它。
 *   这里不对它做推块（推过去还是放不下，写不好就是死循环），但它跨过的每条页线
 *   都是**真实**的翻页位置，逐条记下 —— 早先的版本直接 `continue` 跳过，
 *   结果「一页里塞了一段两页长的经历」时页数少算一页。
 *
 * 不模拟的事（故意的）：分栏版式（`.a4--double`）不用这个函数 —— 见 `paginateColumns`。
 */
export function paginate(blocks: readonly FlowBlock[], pagePx: number = PAGE_CONTENT_PX): Pagination {
  const breaks: number[] = [];
  let offset = 0;
  let height = 0;

  const pushBreak = (at: number): void => {
    if (at <= 0 || breaks[breaks.length - 1] === at) return;
    breaks.push(at);
  };

  for (const block of blocks) {
    if (block.height <= 0) continue;
    const top = block.top + offset;
    let end = top + block.height;

    if (block.height >= pagePx) {
      for (let at = (Math.floor(top / pagePx) + 1) * pagePx; at < end - 1e-6; at += pagePx) pushBreak(at);
      height = Math.max(height, end);
      continue;
    }

    const boundary = (Math.floor(top / pagePx) + 1) * pagePx;
    if (end > boundary) {
      // 整块推到下一页：位移要累加到后面所有块上，否则后面的块会「凭空回退」
      const shift = boundary - top;
      offset += shift;
      end += shift;
      pushBreak(boundary);
    }
    height = Math.max(height, end);
  }

  return { breaks, height, pages: Math.max(1, Math.ceil(height / pagePx - 1e-6)) };
}

/** 分栏版式的栏数（`.a4--double` 是 2 栏） */
export const PAGE_COLUMNS = 2;

/**
 * 分栏版式（`.a4--double`）的页数。
 *
 * 为什么不能套用 `paginate`：分栏容器里正文**不是一条竖着的流** —— 量板块的 top 会看到
 * 它从 1007 突然跳回 0（第二栏从板面顶端重新开始），`paginate` 按一维流去推块，
 * 结果必然是 0 个断点、1 页，而纸上明明印了 2 页（T04 门禁实测：大学通用模板 1 vs 2）。
 *
 * 分栏的真实规则很简单：**每页并排 N 栏，各 N 栏都从页顶排到页底**。于是
 *   总内容量 ≈ N × 板面高 H，一页装得下 N × 一页高 P → 页数 = H / P
 * 栏数在上下同时约掉，所以页数只取决于板面高度 —— 这与浏览器预览量到的 H 是同一个数
 * （屏幕与纸面正文宽都是 182mm，栏宽一样、断行一样）。
 *
 * 断点按等距给出：分栏不存在「整块被推下页」这种累积位移，页线本来就是等距的。
 */
export function paginateColumns(heightPx: number, pagePx: number = PAGE_CONTENT_PX): Pagination {
  // 注意这里不能用 pageCountOf：它按 269mm 固定算，量不到注入的 pagePx（测试里换成一页 1000px 就错）
  const valid = Number.isFinite(heightPx) && heightPx > 0;
  const pages = valid ? Math.max(1, Math.ceil(heightPx / pagePx - 1e-6)) : 1;
  const breaks: number[] = [];
  for (let index = 1; index < pages; index += 1) breaks.push(index * pagePx);
  return { breaks, height: valid ? heightPx : 0, pages };
}

export interface PrintOptions {
  /** 打印前落库草稿（T05 传 `flush`，T03 的测试传 spy） */
  flush?: () => void;
  /** 注入用：默认 `window` / `document` */
  win?: Window;
  doc?: Document;
  /** 兜底清理延迟，测试可缩短 */
  cleanupDelayMs?: number;
}

export type PrintHandle = { ok: true } | { ok: false; reason: string };

/**
 * 走一次打印流程。返回值只表达「有没有能力打印」，不表达「用户按了取消」
 * —— 后者浏览器不告诉我们，也不该猜。
 */
export function printResume(options: PrintOptions = {}): PrintHandle {
  const win = options.win ?? (typeof window === 'undefined' ? undefined : window);
  const doc = options.doc ?? win?.document;
  if (!win || !doc) return { ok: false, reason: PRINT_UNSUPPORTED };

  // ① 草稿先落库：打印的内容必须与屏幕上一字不差
  options.flush?.();

  // ② 能力检查放在副作用之前：没有 print 就什么都不改（不置位、不加监听）
  if (typeof win.print !== 'function') return { ok: false, reason: PRINT_UNSUPPORTED };

  const body = doc.body;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // 清理必须幂等：afterprint 与兜底定时器会竞争，两条路径都要能安全收回状态
  const cleanup = (): void => {
    if (done) return;
    done = true;
    delete body.dataset.printing;
    win.removeEventListener('afterprint', cleanup);
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  body.dataset.printing = '1';
  win.addEventListener('afterprint', cleanup);

  try {
    // ③ 恰一次
    win.print();
  } catch (error) {
    cleanup();
    return { ok: false, reason: error instanceof Error ? error.message : PRINT_UNSUPPORTED };
  }

  // ④ 兜底：afterprint 不来也要把状态收回去（阻塞式实现里 print() 返回即对话框已关）
  timer = setTimeout(cleanup, options.cleanupDelayMs ?? PRINT_CLEANUP_MS);

  return { ok: true };
}
