/**
 * 存储后端（v0.5 / D1）测试。
 *
 * 这里守的最重要一条是**行为零变化**：localStorage 后端写进去的字节，
 * 必须与 v0.4.1 直接调 `localStorage.setItem` 完全一致（长度 + 内容）。
 * 因为「换存储」最容易出的事故不是读不出来，而是「悄悄少存了几个字段」，
 * 而那种事在界面上要过几天才被发现。
 *
 * IndexedDB 在 node 环境下没有全局实现，所以 idb 后端只测「不可用时如何表现」
 * （应当探测失败并干净地退回 localStorage，而不是抛到界面上）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { localBackend } from './backend';
import { decideBackendPath, detectBackend, resetBackendCache } from './detect';
import { emptyDB } from '../defaults';
import { exportJSON } from '../storage';

/** 内存版 localStorage（node 环境没有；与 storage.test.ts 保持同一实现口径） */
class MemoryStorage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  getItem(key: string): string | null {
    const value = this.map.get(key);
    return value === undefined ? null : value;
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

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
  resetBackendCache();
});

describe('localStorage 后端', () => {
  it('写进去再读回来逐字节一致', async () => {
    const payload = JSON.stringify(emptyDB());
    expect(await localBackend.write('jobdesk.v1', payload)).toBeNull();
    const read = await localBackend.read('jobdesk.v1');
    expect(read.status).toBe('ok');
    if (read.status === 'ok') expect(read.value).toBe(payload);
  });

  it('不存在的 key 返回 empty，而不是 error', async () => {
    expect((await localBackend.read('nope')).status).toBe('empty');
  });

  it('keys(prefix) 只列匹配的', async () => {
    await localBackend.write('jobdesk.v1', 'a');
    await localBackend.write('jobdesk.v1.failedAt.1', 'b');
    await localBackend.write('other', 'c');
    expect((await localBackend.keys('jobdesk.v1.failedAt.')).sort()).toEqual(['jobdesk.v1.failedAt.1']);
  });

  it('配额估算能给出 usage / quota，且 quota 是 5MB 口径', async () => {
    await localBackend.write('k', 'x'.repeat(100));
    const est = await localBackend.estimate();
    expect(est).not.toBeNull();
    expect(est!.quota).toBe(5 * 1024 * 1024);
    expect(est!.usage).toBeGreaterThan(0);
  });

  it('remove 之后读不到了', async () => {
    await localBackend.write('k', 'v');
    await localBackend.remove('k');
    expect((await localBackend.read('k')).status).toBe('empty');
  });
});

describe('行为零变化：后端写入与直接 setItem 完全相同', () => {
  it('同一份库 → 同样的字节数、同样的内容', async () => {
    const db = emptyDB();
    const text = JSON.stringify(db);

    // 模拟 v0.4.1 的写法
    localStorage.setItem('direct', text);
    // 走 v0.5 的后端
    await localBackend.write('viaBackend', text);

    const a = localStorage.getItem('direct')!;
    const b = localStorage.getItem('viaBackend')!;
    expect(b).toBe(a);
    expect(b.length).toBe(a.length);
  });
});

describe('后端选择路径', () => {
  it('file:// 直接用 localStorage，连探测都不做', () => {
    const result = decideBackendPath({ protocol: 'file:', hasIDB: false });
    expect(result.choice).toBe('local');
    expect(result.reason).toContain('file://');
  });

  it('file:// 就算有 indexedDB 也不选它（Chrome 会在 open 时抛 SecurityError）', () => {
    expect(decideBackendPath({ protocol: 'file:', hasIDB: true }).choice).toBe('local');
  });

  it('https 有 IDB → 选 idb', () => {
    expect(decideBackendPath({ protocol: 'https:', hasIDB: true }).choice).toBe('idb');
  });

  it('没有 indexedDB → 退回 local 并说明原因', () => {
    const result = decideBackendPath({ protocol: 'https:', hasIDB: false });
    expect(result.choice).toBe('local');
    expect(result.reason).toContain('不支持 IndexedDB');
  });
});

describe('探测降级', () => {
  it('node 环境没有 indexedDB：探测结果必须是 local，且不抛异常', async () => {
    expect(typeof indexedDB).toBe('undefined');
    const result = await detectBackend({ force: true });
    expect(result.choice).toBe('local');
    expect(result.backend.name).toBe('localStorage');
  });

  it('探测结果会被缓存，第二次不再重算', async () => {
    const first = await detectBackend({ force: true });
    const second = await detectBackend();
    expect(second).toBe(first);
  });
});

describe('导出格式不受后端影响', () => {
  it('同一个库导出的 JSON 只差时间戳', () => {
    const db = emptyDB();
    const a = exportJSON(db);
    const b = exportJSON(db);
    const strip = (s: string) => s.replace(/"exportedAt": "[^"]+"/, '');
    expect(strip(a)).toBe(strip(b));
  });
});
