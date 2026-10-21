/**
 * 后端探测：决定这一次运行用哪个存储。
 *
 * 规则（只有三条，别再加）：
 *
 * 1. `file://` 直接用 localStorage，**连试都不试 IndexedDB**。
 *    Chrome 在 file:// 下对 indexedDB.open 抛 SecurityError，Firefox 干脆没有；
 *    试一次的意义只是多一个异常分支。双击打开是主场景，这条路径必须最快最稳。
 * 2. http/https 优先 IndexedDB，探测失败（隐私模式、被策略禁用、老浏览器）退 localStorage。
 * 3. **一旦选定，本次运行不再变**。半路换后端 = 「刚写的数据在哪」变成玄学。
 *
 * 探测本身是一次真实的读写往返（写探针 → 读回 → 删掉），
 * 而不是「看看 indexedDB 在不在」——`in` 判断为真但事务抛错的情况很常见。
 */

import { localBackend, type StorageBackend } from './backend';
import { idbBackend } from './idb';

const PROBE_KEY = '__jobdesk_probe__';

export type BackendChoice = 'local' | 'idb';

export interface DetectionResult {
  backend: StorageBackend;
  choice: BackendChoice;
  /** 为什么退到 localStorage —— 只在 debug/设置页展示，不弹窗打扰 */
  reason?: string;
}

let cached: DetectionResult | null = null;

/** 走到哪个分支（纯函数，便于测） */
export function decideBackendPath(input: {
  protocol: string;
  hasIDB: boolean;
}): { choice: BackendChoice; reason?: string } {
  if (input.protocol === 'file:') {
    return { choice: 'local', reason: '以文件方式打开（file://），使用 localStorage' };
  }
  if (!input.hasIDB) {
    return { choice: 'local', reason: '当前浏览器不支持 IndexedDB，使用 localStorage' };
  }
  return { choice: 'idb' };
}

async function probeIDB(): Promise<string | null> {
  // 返回 null = 可用；返回字符串 = 不可用的原因
  try {
    const writeError = await idbBackend.write(PROBE_KEY, '1');
    if (writeError) return writeError;
    const read = await idbBackend.read(PROBE_KEY);
    await idbBackend.remove(PROBE_KEY);
    if (read.status !== 'ok') return 'IndexedDB 写入后读不回来';
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'IndexedDB 探测失败';
  }
}

/**
 * 探测并缓存。测试里可传 `force` 绕过缓存。
 * 注意：这不是「同步 API」，启动路径需要 await 一次 —— 只此一处。
 */
export async function detectBackend(options: { force?: boolean } = {}): Promise<DetectionResult> {
  if (cached && !options.force) return cached;

  const protocol = typeof location === 'undefined' ? '' : location.protocol;
  const hasIDB = typeof indexedDB !== 'undefined';
  const path = decideBackendPath({ protocol, hasIDB });

  if (path.choice === 'local') {
    cached = { backend: localBackend, choice: 'local', reason: path.reason };
    return cached;
  }

  const probeError = await probeIDB();
  if (probeError) {
    cached = {
      backend: localBackend,
      choice: 'local',
      reason: `IndexedDB 不可用（${probeError}），已退回 localStorage`,
    };
    return cached;
  }

  cached = { backend: idbBackend, choice: 'idb' };
  return cached;
}

/** 仅供测试：清掉缓存（避免用例之间互相污染） */
export function resetBackendCache(): void {
  cached = null;
}

/** 读一下当前选择（没探测过返回 null），给设置页展示用，不触发探测 */
export function peekBackend(): DetectionResult | null {
  return cached;
}
