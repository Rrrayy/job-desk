/**
 * 文件句柄与权限层（D8 第 5、6 层）。
 *
 * 两条不可越过的约束：
 *
 * ① **句柄身份只能用 `isSameEntry` 判**。
 *    用 name / path 判身份在文件系统里是错的：用户完全可以有两个同名文件，
 *    或者把文件改名后仍然用同一个句柄。判错的后果是「把 A 文件的内容写进 B 文件」，
 *    这是不可恢复的破坏。
 *
 * ② **权限不会跟句柄一起自动回来**。
 *    句柄存在 IndexedDB 里可以跨会话保留，但浏览器只保留「曾经授权过」这个事实，
 *    不保留授权本身。每次加载都必须重新 `requestPermission()`，
 *    而且这个调用必须在用户手势里（click），不能在启动时自动调（会被直接拒）。
 *    被拒 → 降级到手动导入导出，**绝不死缠烂打地弹窗**。
 *
 * ★ 本文件不碰 React、不碰 DB 结构，只负责「把浏览器给的那坨东西包成可测的小接口」。
 *   测试里用假句柄注入，不在 jsdom 里伪造 File System Access。
 */

/** 只声明我们真正用到的三个方法，避免依赖 lib.dom 是否带了 FS Access 类型 */
export interface FileHandleLike {
  readonly name: string;
  readonly kind: 'file';
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<WritableLike>;
  isSameEntry?(other: FileHandleLike): Promise<boolean>;
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export interface WritableLike {
  write(data: string | BufferSource | Blob): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export interface DirHandleLike {
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  getDirectoryHandle?(name: string, options?: { create?: boolean }): Promise<DirHandleLike>;
}

/** 能力探测的三种结论；UI 与引擎只认这三种，不各自去嗅探 API */
export type FileLinkCapability = 'full' | 'unsupported' | 'insecure';

/**
 * 能力探测。
 *
 * - `full`：Chromium 桌面，`showSaveFilePicker` 与 `createWritable` 都在。
 * - `insecure`：有 API 但页面不是安全上下文（http 自建服务器）。
 *   单独分出来是因为它的建议不一样：换 https 就能用，不是「换浏览器」。
 * - `unsupported`：Safari / Firefox / 移动端。降级 L1 手动导入导出。
 */
export function detectFileLinkCapability(): FileLinkCapability {
  const g = globalThis as unknown as {
    showSaveFilePicker?: unknown;
    showOpenFilePicker?: unknown;
    isSecureContext?: boolean;
  };
  if (typeof g.showSaveFilePicker !== 'function' || typeof g.showOpenFilePicker !== 'function') {
    return 'unsupported';
  }
  // file:// 下 isSecureContext 为 true，这是本应用的主场景，不受影响
  if (g.isSecureContext === false) return 'insecure';
  return 'full';
}

/* --------------------------- 句柄存取（IndexedDB） --------------------------- */

/**
 * 句柄本身是可结构化克隆的对象，能直接放进 IndexedDB ——
 * 但也**只能**放进 IndexedDB：localStorage 只存字符串，塞不进去。
 *
 * 这里不复用 lib/storage/idb.ts 的连接：那一个是「主数据后端」，
 * 它的失败会触发只读锁定；句柄存储失败只是「下次要重新选文件」，
 * 严重程度完全不同，不能共用一个失败处理路径。
 */
const HANDLE_DB = 'jobdesk.fs';
const HANDLE_STORE = 'handles';

function openHandleDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(HANDLE_DB, 1);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('句柄库打开失败'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openHandleDB();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, mode);
      const request = run(tx.objectStore(HANDLE_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('句柄读写失败'));
    });
  } finally {
    db.close();
  }
}

export async function saveHandle(handle: FileHandleLike | DirHandleLike): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  try {
    await withStore('readwrite', (store) => store.put(handle, 'linked'));
    return true;
  } catch {
    // 存不下就只是「下次要重新选」，绝不能因此拦住本次保存
    return false;
  }
}

export async function loadHandle(): Promise<FileHandleLike | DirHandleLike | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const value = await withStore<unknown>('readonly', (store) => store.get('linked'));
    return (value as FileHandleLike | DirHandleLike) ?? null;
  } catch {
    return null;
  }
}

export async function clearHandle(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    await withStore('readwrite', (store) => store.delete('linked'));
  } catch {
    // 清不掉不影响任何正确性：下次加载会因为权限被拒而要求重新选择
  }
}

/* ------------------------------ 权限与身份 ------------------------------ */

export type PermissionOutcome = 'granted' | 'denied' | 'prompt';

/**
 * 查询当前权限（不弹窗）。
 * 老 Safari 没有这个方法 → 当作 `prompt`，让调用方走「请用户点一下」的路径。
 */
export async function checkPermission(handle: FileHandleLike, mode: 'read' | 'readwrite' = 'readwrite'): Promise<PermissionOutcome> {
  if (typeof handle.queryPermission !== 'function') return 'prompt';
  try {
    return (await handle.queryPermission({ mode })) as PermissionOutcome;
  } catch {
    return 'prompt';
  }
}

/**
 * 请求权限。**必须在用户手势（click）里调用**，否则浏览器直接返回 denied。
 * 调用方要在 UI 上把「连接文件」做成一个明确的按钮，而不是启动时偷偷调。
 */
export async function requestPermission(handle: FileHandleLike, mode: 'read' | 'readwrite' = 'readwrite'): Promise<PermissionOutcome> {
  if (typeof handle.requestPermission !== 'function') return 'denied';
  try {
    return (await handle.requestPermission({ mode })) as PermissionOutcome;
  } catch {
    return 'denied';
  }
}

/**
 * 句柄身份判定（第 5 层）。
 *
 * ★ 三态而不是布尔：`unknown` 是「双方都不支持 isSameEntry」的诚实表达。
 *   把它当 false 会让「同一个文件」被误判成冲突，每天给用户造一个假冲突；
 *   当 true 则可能在两个不同文件之间静默覆盖。两种都不可接受，所以显式留一档。
 */
export async function isSameFile(a: FileHandleLike | null, b: FileHandleLike | null): Promise<boolean | 'unknown'> {
  if (!a || !b) return false;
  // `typeof a.isSameEntry !== 'function'` 这个判断不够：类实例上「声明了但没赋值」的
  // 可选方法，在原型上仍然是一个 undefined 值的属性，typeof 拿到的是 'undefined'
  // 没问题，但某些包装（Proxy / 序列化回来的句柄）会给出一个**可调用却返回假值**的桩，
  // 那种场合静默返回 false 比抛错更危险 —— 所以这里既检查类型，也检查返回值。
  const probe: unknown = a.isSameEntry;
  if (typeof probe !== 'function') return 'unknown';
  try {
    const same: unknown = await (probe as (other: FileHandleLike) => Promise<unknown>).call(a, b);
    return typeof same === 'boolean' ? same : 'unknown';
  } catch {
    return 'unknown';
  }
}
