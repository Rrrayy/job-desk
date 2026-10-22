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
