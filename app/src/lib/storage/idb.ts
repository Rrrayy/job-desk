/**
 * IndexedDB 后端（v0.5 / D1）。
 *
 * ★ 为什么自己写 60 行而不上 Dexie：
 *   方案里写的是 Dexie，但它会让产物多出约 25 KB（gzip 后）且引入一个只在
 *   「大库用户」身上才值回成本的依赖。这个应用只需要 `get / put / delete /
 *   按前缀列 key / 配额查询` 五个动作，原生 IDB 足够 ——
 *   而「单文件、零外部运行时依赖」是这个项目对用户的核心承诺之一。
 *   决策记在 CHANGELOG：**不引 Dexie**，理由是收益（拆表 DSL）属 v0.6 才用得上。
 *
 * 存储形态与 localStorage 后端保持一致：一个 object store，key = 字符串，value = 字符串。
 * 不拆表 —— 拆表是 v0.6 的事，这一版只解决「5 MB 天花板」。
 */

import type { ReadOutcome, StorageBackend } from './backend';

const DB_NAME = 'jobdesk';
const DB_VERSION = 1;
const STORE = 'kv';

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

/**
 * 打开（并按需建库）。
 * 失败一律 reject —— 调用方（`detectBackend`）据此决定退回 localStorage。
 */
function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      // file:// 下 Chrome 抛 SecurityError，走这里
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'));
    request.onblocked = () => reject(new Error('IndexedDB 被其他标签页占用'));
  });
}

/** 懒连接：第一次读写时才开库，避免启动时为一个可能用不上的后端买单 */
let connection: Promise<IDBDatabase> | null = null;

function conn(): Promise<IDBDatabase> {
  if (!connection) {
    connection = openIDB().catch((error: unknown) => {
      connection = null; // 下次重试，不要缓存一个永久失败
      throw error;
    });
  }
  return connection;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await conn();
  const tx = db.transaction(STORE, mode);
  const store = tx.objectStore(STORE);
  const result = await fn(store);
  // 写事务必须等 complete，否则「返回成功但其实没落盘」
  if (mode === 'readwrite') {
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务被中止'));
    });
  }
  return result;
}

export const idbBackend: StorageBackend = {
  name: 'IndexedDB',

  async read(key): Promise<ReadOutcome> {
    try {
      const value = await withStore('readonly', (store) => requestToPromise(store.get(key)));
      if (typeof value !== 'string') return { status: 'empty' };
      return { status: 'ok', value };
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      return { status: 'error', message: `读取 IndexedDB 失败（${message}）。` };
    }
  },

  async write(key, value) {
    try {
      await withStore('readwrite', (store) => requestToPromise(store.put(value, key)));
      return null;
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'QuotaExceededError') {
        return {
          quotaExceeded: true,
          message: '浏览器存储配额已满，已暂停写入（只读模式）以防数据丢失。请先导出备份，再清理一批已结束的投递。',
        };
      }
      const message = error instanceof Error ? error.message : '未知错误';
      return { message: `保存失败（${message}）。请立刻导出备份。` };
    }
  },

  async remove(key) {
    try {
      await withStore('readwrite', (store) => requestToPromise(store.delete(key)));
    } catch {
      /* 删不掉不打断用户 */
    }
  },

  async keys(prefix) {
    try {
      const all = await withStore('readonly', (store) => requestToPromise(store.getAllKeys()));
      return all.map(String).filter((key) => key.startsWith(prefix));
    } catch {
      return [];
    }
  },

  async estimate() {
    try {
      if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
      const { usage, quota } = await navigator.storage.estimate();
      if (typeof usage !== 'number' || typeof quota !== 'number') return null;
      return { usage, quota };
    } catch {
      return null;
    }
  },
};
