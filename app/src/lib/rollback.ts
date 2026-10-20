/**
 * 迁移回滚点。
 *
 * 铁律（PRD §D.2 契约 5）：**先备份后改**。回滚点写失败 → 调用方必须中止迁移。
 * 宁可这次打不开新版，也不能在没退路的情况下动用户数据。
 */

export const MIGRATION_POINTER_KEY = 'jobdesk.v1.migration';
export const BACKUP_KEY_PREFIX = 'jobdesk.v1.preMigrate.';
export const BACKUP_TTL_DAYS = 30;

export interface MigrationPointer {
  from: number;
  to: number;
  at: string;
  backupKey: string;
  status: 'done' | 'failed' | 'aborted';
  /** 失败原因，直接展示给用户 */
  reason?: string;
}

function storageAvailable(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

/** 写回滚点（整份原始 JSON 字符串）。写失败必须返回 ok:false，调用方中止迁移 */
export function writeRollbackPoint(
  rawV1: string,
  at: string,
): { ok: true; key: string } | { ok: false; error: string } {
  if (!storageAvailable()) return { ok: false, error: '当前浏览器不支持本地存储，无法创建回滚点' };
  const key = `${BACKUP_KEY_PREFIX}${at}`;
  try {
    localStorage.setItem(key, rawV1);
    // 读回来确认真的写进去了（部分浏览器配额满时 setItem 会静默失败）
    if (localStorage.getItem(key) !== rawV1) {
      return { ok: false, error: '回滚点写入后校验失败，可能是存储空间不足' };
    }
    return { ok: true, key };
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return { ok: false, error: `写入回滚点失败（${message}），可能是存储空间不足或被禁用` };
  }
}

export function readRollbackPoint(key: string): string | null {
  if (!storageAvailable() || !key) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 启动时清理超过 30 天的回滚点（只清自己前缀，绝不碰别的 key） */
export function sweepRollbackPoints(now: string): void {
  if (!storageAvailable()) return;
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return;
  const stale: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(BACKUP_KEY_PREFIX)) continue;
      const stamp = Date.parse(key.slice(BACKUP_KEY_PREFIX.length));
      if (!Number.isFinite(stamp)) continue;
      if (nowMs - stamp > BACKUP_TTL_DAYS * 24 * 3600 * 1000) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    // 清理失败不影响主流程
  }
}

export function readPointer(): MigrationPointer | null {
  if (!storageAvailable()) return null;
  try {
    const raw = localStorage.getItem(MIGRATION_POINTER_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const status = record.status;
    if (status !== 'done' && status !== 'failed' && status !== 'aborted') return null;
    return {
      from: typeof record.from === 'number' ? record.from : 1,
      to: typeof record.to === 'number' ? record.to : 2,
      at: typeof record.at === 'string' ? record.at : '',
      backupKey: typeof record.backupKey === 'string' ? record.backupKey : '',
      status,
      reason: typeof record.reason === 'string' ? record.reason : undefined,
    };
  } catch {
    return null;
  }
}

export function writePointer(pointer: MigrationPointer): void {
  if (!storageAvailable()) return;
  try {
    localStorage.setItem(MIGRATION_POINTER_KEY, JSON.stringify(pointer));
  } catch {
    // 指针写失败不影响数据本身；回滚点仍在
  }
}
