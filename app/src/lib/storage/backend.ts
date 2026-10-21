/**
 * 存储后端抽象（v0.5 / D1）。
 *
 * 为什么要有这一层：v0.4.1 之前所有持久化都直接调 `localStorage`，
 * 于是「5 MB 天花板」被焊死在代码里 —— 秋招一家记二十条笔记就撞线。
 * 但**不能直接迁 IndexedDB**：产物是单文件、用户双击 `file://` 打开，
 * 而多数浏览器在 `file://` 下不给 IndexedDB（Chrome 直接 SecurityError，
 * Firefox 更严格）。所以做法是「抽接口 + 双后端 + 启动探测」：
 *
 *   - http/https  → IndexedDB（容量按磁盘百分比算，几百 MB 起步）
 *   - file://     → localStorage（保持双击即用的现状，行为与 v0.4.1 一字不差）
 *
 * 三条铁律：
 *
 * 1. **local 后端行为零变化**。回归断言是「同一份数据写进去，
 *    主 key 的字节数与 sha256 与 v0.4.1 完全一致」。这一层只做搬运，不做任何格式加工。
 * 2. **不猜、不 fallback**。`file://` 下绝不「试一下 IDB，失败再退」——
 *    探测结果在启动时定一次，之后固定不变。半路换后端会让「刚写进去的数据在哪」变成玄学。
 * 3. **后端只管整份文档的读写**，不拆表、不管迁移、不管校验。
 *    拆表是 v0.6 的事；这里先解决容量。
 */

/** 一次读取的结果：要么有值，要么空，要么读失败（失败必须能说出原因） */
export type ReadOutcome =
  | { status: 'ok'; value: string }
  | { status: 'empty' }
  | { status: 'error'; message: string };

export interface StorageBackend {
  /** 便于日志与设置页展示，如 'localStorage' / 'IndexedDB' */
  readonly name: string;
  /** 同步读取。IndexedDB 是异步的，所以这里返回 Promise —— 接口按最慢的那个定 */
  read(key: string): Promise<ReadOutcome>;
  /** 写成功返回 null，失败返回面向用户的中文原因 */
  write(key: string, value: string): Promise<string | null>;
  remove(key: string): Promise<void>;
  /** 列出以某前缀开头的所有 key（回滚点、坏数据副本都靠它做清理） */
  keys(prefix: string): Promise<string[]>;
  /** 当前后端还能不能写（配额预检用）；null = 未知 */
  estimate(): Promise<{ usage: number; quota: number } | null>;
}

/* ------------------------------ localStorage ------------------------------ */

export const localBackend: StorageBackend = {
  name: 'localStorage',

  async read(key) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? { status: 'empty' } : { status: 'ok', value };
    } catch {
      return { status: 'error', message: '浏览器禁止了本地存储，数据无法读取。请检查隐私设置。' };
    }
  },

  async write(key, value) {
    try {
      localStorage.setItem(key, value);
      return null;
    } catch (error) {
      return describeWriteError(error);
    }
  },

  async remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* 删不掉就算了，不值得因此打断用户 */
    }
  },

  async keys(prefix) {
    const out: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith(prefix)) out.push(key);
      }
    } catch {
      /* 读不到就当没有 */
    }
    return out;
  },

  async estimate() {
    // localStorage 没有配额查询 API，用总字符数估算（UTF-16，2 字节/字符）
    try {
      let chars = 0;
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key) continue;
        chars += key.length + (localStorage.getItem(key)?.length ?? 0);
      }
      return { usage: chars * 2, quota: 5 * 1024 * 1024 };
    } catch {
      return null;
    }
  },
};

function describeWriteError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return '浏览器存储空间已满（这个打开方式下约 5 MB）。请先导出备份，再清理一批已结束的投递。';
  }
  const message = error instanceof Error ? error.message : '未知错误';
  return `保存失败（${message}）。可能是浏览器存储空间不足或被禁用。请立刻导出备份。`;
}

export { describeWriteError };
