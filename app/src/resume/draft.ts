/**
 * 草稿写入通道（ARCH A-07）：**编辑期不入撤销栈，落库才入**。
 *
 * 为什么必须有这一层：`mutate` 每次都要 `cloneDB` 整库（500 条投递时是几十 KB 的
 * JSON 往返）+ 写盘；逐字输入就是逐字整库克隆，输一行字能卡出可见的掉帧。
 * 而 `⌘Z` 的既有语义是「操作级回退」，不是文本撤销 —— 所以编辑期本来也不该入栈。
 *
 * 这一层刻意做成**零 React**：计时器、取消、立即 flush 三件事都能用假时钟单测，
 * 而 React 侧只剩一个 12 行的 `useResumeDraft`（在 components/resume 下）。
 *
 * ★ 一个容易漏的约束：`flush()` 必须在**组件卸载**与**AI 写回前**都调一次。
 * 否则「输入 → 立刻点 AI 润色 → AI 写回 → 防抖计时器到点」会用旧草稿覆盖 AI 的写入。
 */

/** 输入停止多久后落库（PRD/ARCH 定的 400 ms） */
export const DRAFT_DEBOUNCE_MS = 400;

export interface DraftWriter<T> {
  /** 记下最新值并（重新）开始计时；中间值直接丢弃，只落最后一次 */
  schedule(value: T): void;
  /** 立刻落库（有未提交的值才调 commit）；无待提交时是 no-op */
  flush(): void;
  /** 丢弃待提交的值（外部改写生效、草稿被替换时用） */
  cancel(): void;
  /** 是否有待提交的值 */
  pending(): boolean;
}

/**
 * 造一个「最后一次赢」的防抖写入器。
 *
 * 语义写死在测试里，三句话：
 * 1. 400 ms 内连续 schedule 5 次 → commit **只被调用 1 次**，且值是第 5 次那个；
 * 2. flush 会立刻把待提交值写掉，并清空计时器（不会再多一次重复 commit）；
 * 3. cancel 之后计时器到点也不写（外部内容才是真相）。
 */
export function createDraftWriter<T>(
  commit: (value: T) => void,
  delayMs: number = DRAFT_DEBOUNCE_MS,
): DraftWriter<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 用「持有者对象」而不是 `let latest: T` + 一个 hasValue 布尔：
  // 后者在 strict 下需要一次 `as T` 断言才能收窄，而断言正好会掩盖「没值也提交」的 bug。
  let holder: { value: T } | null = null;

  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const take = (): T | null => {
    if (!holder) return null;
    const value = holder.value;
    holder = null;
    return value;
  };

  return {
    schedule(value: T): void {
      holder = { value };
      clear();
      timer = setTimeout(() => {
        timer = null;
        const pending = take();
        if (pending !== null) commit(pending);
      }, delayMs);
    },
    flush(): void {
      clear();
      const pending = take();
      if (pending !== null) commit(pending);
    },
    cancel(): void {
      clear();
      holder = null;
    },
    pending(): boolean {
      return holder !== null;
    },
  };
}
