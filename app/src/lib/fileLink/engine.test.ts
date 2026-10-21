/**
 * 文件联动（D8）回归。
 *
 * 这一组测试全部用**内存假文件系统**，不在 jsdom 里伪造 File System Access ——
 * 后者既不可靠（jsdom 根本没有这个 API），也会让测试变成「测浏览器」而不是「测协议」。
 *
 * 守的六条红线（对应 §3.3 的六层）：
 * 1. 队列深度 1：连续 10 次保存只落最后一版
 * 2. write-ahead：写入前先落 pending，成功后清除
 * 3. 原子提交：写完必须 truncate（不留旧尾巴）
 * 4. 冲突检测：以「我们上次写完的 hash」为基准，不一致就不写主文件、只写冲突副本
 * 5. 句柄身份：isSameEntry 缺失时返回 'unknown'，不假装 true
 * 6. 权限丢失：只读 + 三出口，绝不自动改文件
 */

import { beforeEach, describe, expect, it } from 'vitest';

/**
 * 内存版 localStorage。
 *
 * 为什么不用 jsdom 环境：这一组测的是**协议**（队列 / 缓冲 / 冲突），
 * 不是浏览器能力。D-04 规定默认 node 环境，给一个 20 行的假存储比
 * 把整个文件拖进 jsdom 更贴合「单元测试测纯逻辑」的分层。
 */
class MemStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

const store = new MemStorage();
Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true });

import {
  READ_ONLY_EXITS,
  bindHandle,
  clearPendingWrite,
  conflictFileName,
  describeReadOnly,
  establishBaseline,
  peekPendingWrite,
  replayPending,
  requestWrite,
  resetBaseline,
  whenQueueIdle,
} from './engine';
import { type FileHandleLike, detectFileLinkCapability, isSameFile } from './handle';
import { MAX_REPLAY_FAILURES, PENDING_WRITE_TTL_DAYS, decideReplay, markReplayFailed, parsePending, type PendingWrite } from './pending';
import { sha256Fallback } from './hash';

/* --------------------------- 内存假文件系统 --------------------------- */

class MemWritable {
  constructor(private readonly file: MemFile) {}
  private buffer = '';
  private truncated = false;

  async write(data: string): Promise<void> {
    this.buffer += data;
  }

  async truncate(size: number): Promise<void> {
    this.truncated = true;
    this.buffer = this.buffer.slice(0, size);
  }

  async close(): Promise<void> {
    // 没 truncate 就是「补丁式写入」：从 0 开始覆盖，但不裁掉尾巴
    this.file.content = this.truncated ? this.buffer : this.buffer + this.file.content.slice(this.buffer.length);
    this.file.closeCount += 1;
  }

  async abort(): Promise<void> {}
}

class MemFile {
  content: string;
  closeCount = 0;
  /** 注入写入失败（模拟断电 / 权限被收回） */
  failOnClose = false;
  /** 注入「文件被外部改过」 */
  externalWrite: string | null = null;

  constructor(initial: string) {
    this.content = initial;
  }
}

class MemHandle implements FileHandleLike {
  readonly kind = 'file' as const;
  constructor(
    readonly name: string,
    readonly file: MemFile,
    private readonly permission: 'granted' | 'denied' | 'prompt' = 'granted',
    private readonly sameEntry: boolean | undefined = true,
  ) {}

  async getFile(): Promise<File> {
    if (this.file.externalWrite !== null) {
      this.file.content = this.file.externalWrite;
      this.file.externalWrite = null;
    }
    return { text: async () => this.file.content } as unknown as File;
  }

  async createWritable(): Promise<MemWritable> {
    if (this.file.failOnClose) throw new Error('模拟写入失败');
    return new MemWritable(this.file);
  }

  async queryPermission(): Promise<PermissionState> {
    return this.permission as PermissionState;
  }

  async requestPermission(): Promise<PermissionState> {
    return this.permission as PermissionState;
  }

  async isSameEntry(other: FileHandleLike): Promise<boolean> {
    if (this.sameEntry === undefined) throw new Error('unsupported');
    return other === this ? this.sameEntry : !this.sameEntry;
  }
}

function makeHandle(content = '{"v":0}'): { handle: MemHandle; file: MemFile } {
  const file = new MemFile(content);
  return { handle: new MemHandle('data.json', file), file };
}

beforeEach(() => {
  localStorage.clear();
  resetBaseline();
  clearPendingWrite();
  bindHandle(null);
});

/* ------------------------------ 第 1 层：队列 ------------------------------ */

describe('D8-1 · 写入队列（深度 1）', () => {
  it('连续 10 次保存只落最后一版，且只写一次文件', async () => {
    const { handle, file } = makeHandle();
    bindHandle(handle);
    for (let i = 1; i <= 10; i += 1) requestWrite(`{"v":${i}}`, '2026-10-21T10:00:00.000Z');
    const outcome = await whenQueueIdle();

    expect(outcome?.status).toBe('written');
    expect(file.content).toBe('{"v":10}');
    // 队列串行 + 防抖合并：10 次请求不该产生 10 次 close
    expect(file.closeCount).toBeLessThanOrEqual(2);
  });

  it('内容没变就跳过（不把 mtime 刷成噪音）', async () => {
    const { handle, file } = makeHandle();
    bindHandle(handle);
    await establishBaseline(handle, '2026-10-21T09:00:00.000Z');
    requestWrite('{"v":0}');
    const outcome = await whenQueueIdle();
    expect(outcome?.status).toBe('skipped');
    expect(file.closeCount).toBe(0);
  });

  it('没有句柄时明确失败，不会静默丢弃', async () => {
    requestWrite('{"v":1}');
    const outcome = await whenQueueIdle();
    expect(outcome?.status).toBe('failed');
  });
});

/* --------------------------- 第 2 层：write-ahead --------------------------- */

describe('D8-2 · write-ahead buffer', () => {
  it('写入成功 → pending 被清空，基准 hash 更新', async () => {
    const { handle } = makeHandle();
    bindHandle(handle);
    requestWrite('{"v":1}', '2026-10-21T10:00:00.000Z');
    await whenQueueIdle();
    expect(peekPendingWrite()).toBeNull();
    // 基准已更新 → 再写同样的内容会被判定 unchanged
    requestWrite('{"v":1}');
    const again = await whenQueueIdle();
    expect(again?.status).toBe('skipped');
  });

  it('中断的写入在下次启动被重放（文件没被别人改过）', async () => {
    const { handle, file } = makeHandle('{"v":0}');
    // 手工造一条「上次写到一半断电」的 pending
    localStorage.setItem(
      'jobdesk.v1.fsPending',
      JSON.stringify({
        contentHash: sha256Fallback('{"v":0}'),
        payload: '{"v":9}',
        createdAt: '2026-10-21T10:00:00.000Z',
        status: 'pending',
        attempts: 0,
      }),
    );
    const outcome = await replayPending(handle, '2026-10-21T10:01:00.000Z');
    expect(outcome.status).toBe('replayed');
    expect(file.content).toBe('{"v":9}');
    expect(peekPendingWrite()).toBeNull();
  });

  it('文件被外部改过 → 不重放，改为生成冲突副本', async () => {
    const { handle, file } = makeHandle('{"v":0}');
    localStorage.setItem(
      'jobdesk.v1.fsPending',
      JSON.stringify({
        contentHash: sha256Fallback('{"v":0}'),
        payload: '{"v":9}',
        createdAt: '2026-10-21T10:00:00.000Z',
        status: 'pending',
        attempts: 0,
      }),
    );
    file.content = '{"v":"外部改的"}';
    const outcome = await replayPending(handle, '2026-10-21T10:01:00.000Z');
    // 没有目录句柄 → 冲突副本写不出来 → 明确失败，且主文件不动
    expect(outcome.status).toBe('failed');
    expect(file.content).toBe('{"v":"外部改的"}');
  });

  it('连续失败到上限 → 标记 failed，payload 保留供人工恢复', () => {
    let pending: PendingWrite = {
      contentHash: 'a',
      payload: 'p',
      createdAt: '2026-10-21T10:00:00.000Z',
      status: 'pending',
      attempts: 0,
    };
    for (let i = 0; i < MAX_REPLAY_FAILURES; i += 1) {
      pending = markReplayFailed(pending, `失败 ${i}`, '2026-10-21T10:00:00.000Z');
    }
    expect(pending.status).toBe('failed');
    expect(pending.payload).toBe('p');
    expect(decideReplay(pending, 'a', '2026-10-21T10:00:00.000Z').action).toBe('giveUp');
  });

  it('超期（> 30 天）的 pending 直接丢弃，哪怕文件没变', () => {
    const pending: PendingWrite = {
      contentHash: 'a',
      payload: 'p',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'pending',
      attempts: 0,
    };
    const later = new Date(Date.parse(pending.createdAt) + (PENDING_WRITE_TTL_DAYS + 1) * 86_400_000).toISOString();
    expect(decideReplay(pending, 'a', later)).toEqual({
      action: 'drop',
      reason: expect.stringContaining(String(PENDING_WRITE_TTL_DAYS)),
    });
  });
});

/* ------------------------- 第 3 层：原子提交（截断） ------------------------- */

describe('D8-3 · 原子提交', () => {
  it('新内容更短时必须 truncate，否则尾巴会残留成坏 JSON', async () => {
    const { handle, file } = makeHandle('{"veryLong":true,"padding":"xxxxxxxxxx"}');
    bindHandle(handle);
    requestWrite('{"v":1}');
    await whenQueueIdle();
    expect(file.content).toBe('{"v":1}');
    // 能被重新解析回来才是真的没尾巴
    expect(() => JSON.parse(file.content)).not.toThrow();
  });

  it('写入抛错时 pending 保留（下次启动还有救）', async () => {
    const { handle, file } = makeHandle();
    bindHandle(handle);
    file.failOnClose = true;
    requestWrite('{"v":2}', '2026-10-21T10:00:00.000Z');
    const outcome = await whenQueueIdle();
    expect(outcome?.status).toBe('failed');
    expect(peekPendingWrite()?.payload).toBe('{"v":2}');
  });
});

/* ------------------------- 第 4 层：冲突检测 ------------------------- */

describe('D8-4 · 冲突检测以「我们上次写完的 hash」为基准', () => {
  it('首次连接不判冲突（外部生成的文件本身就与基准不同）', async () => {
    const { handle, file } = makeHandle('{"external":true}');
    bindHandle(handle);
    requestWrite('{"v":1}');
    const outcome = await whenQueueIdle();
    expect(outcome?.status).toBe('written');
    expect(file.content).toBe('{"v":1}');
  });

  it('文件被外部改过后再保存 → 不覆盖主文件，返回冲突', async () => {
    const { handle, file } = makeHandle('{"v":0}');
    bindHandle(handle);
    requestWrite('{"v":1}');
    await whenQueueIdle();

    // 外部（另一个编辑器 / 同步盘）改了文件
    file.content = '{"v":"外部"}';
    requestWrite('{"v":2}');
    const outcome = await whenQueueIdle();

    // 没有目录句柄 → 写不出副本 → 明确失败；关键是主文件没被覆盖
    expect(outcome?.status).toBe('failed');
    if (outcome?.status === 'failed') expect(outcome.error).toContain('冲突');
    expect(file.content).toBe('{"v":"外部"}');
  });

  it('冲突文件名按本地时区生成，形如 data.conflict-YYYYMMDD-HHMMSS.json', () => {
    const name = conflictFileName('2026-10-21T08:07:06.000Z');
    expect(name).toMatch(/^data\.conflict-\d{8}-\d{6}\.json$/);
    expect(name).toHaveLength('data.conflict-'.length + 15 + '.json'.length);
  });
});

/* ------------------------- 第 5/6 层：身份与权限 ------------------------- */

describe('D8-5/6 · 句柄身份与权限', () => {
  it('isSameEntry 缺失 → 返回 unknown，不假装相同也不假装不同', async () => {
    const base = new MemHandle('a.json', new MemFile(''), 'granted', undefined);
    // 造一个「真的没有这个方法」的句柄：老 Safari 的 FileSystemFileHandle 就是这样。
    // 不能用 MemHandle（它在原型上有声明），否则测到的是「抛错」而不是「缺失」。
    const bare = {
      name: 'a.json',
      kind: 'file' as const,
      getFile: () => base.getFile(),
      createWritable: () => base.createWritable(),
    } as unknown as FileHandleLike;
    expect(typeof bare.isSameEntry).toBe('undefined');
    expect(await isSameFile(bare, base)).toBe('unknown');
    expect(await isSameFile(null, base)).toBe(false);
  });

  it('同名不同文件 → 被判为不同（身份判定绝不能看 name）', async () => {
    const a = new MemHandle('data.json', new MemFile(''));
    const b = new MemHandle('data.json', new MemFile(''));
    expect(await isSameFile(a, b)).toBe(false);
    expect(await isSameFile(a, a)).toBe(true);
  });

  it('权限不是 granted → 不写文件，返回 need-permission', async () => {
    const file = new MemFile('{"v":0}');
    const handle = new MemHandle('data.json', file, 'denied');
    bindHandle(handle);
    requestWrite('{"v":1}');
    const outcome = await whenQueueIdle();
    expect(outcome?.status).toBe('need-permission');
    expect(file.closeCount).toBe(0);
    expect(file.content).toBe('{"v":0}');
  });

  it('只读锁定三出口齐全，且文案里必须承诺「原始文件没动」', () => {
    expect(READ_ONLY_EXITS).toEqual(['download', 'retry', 'save-as']);
    for (const reason of ['parse-failed', 'schema-incompatible', 'permission-lost'] as const) {
      const state = describeReadOnly(reason);
      expect(state.active).toBe(true);
      expect(state.message).toContain('一个字都没动');
    }
    expect(describeReadOnly(null).active).toBe(false);
  });
});

/* ------------------------------ 能力探测 ------------------------------ */

describe('D8 · 能力探测', () => {
  it('没有 showSaveFilePicker → unsupported（Safari / Firefox / 移动端）', () => {
    expect(detectFileLinkCapability()).toBe('unsupported');
  });

  it('有 API 但非安全上下文 → insecure（换 https 就能用，不是换浏览器）', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.showSaveFilePicker = () => {};
    g.showOpenFilePicker = () => {};
    Object.defineProperty(globalThis, 'isSecureContext', { value: false, configurable: true });
    expect(detectFileLinkCapability()).toBe('insecure');
    delete g.showSaveFilePicker;
    delete g.showOpenFilePicker;
    Object.defineProperty(globalThis, 'isSecureContext', { value: true, configurable: true });
  });
});

/* ------------------------------ pending 解析 ------------------------------ */

describe('D8 · pending 序列化要经得住坏值', () => {
  it('坏 JSON / 缺字段 / 类型错 → 一律 null，绝不抛', () => {
    expect(parsePending(null)).toBeNull();
    expect(parsePending('{不是 JSON')).toBeNull();
    expect(parsePending('[1,2,3]')).toBeNull();
    expect(parsePending('{"payload":"x"}')).toBeNull();
    expect(parsePending('{"contentHash":"a","payload":"x","createdAt":"2026-10-21T00:00:00.000Z"}')).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
  });
});
