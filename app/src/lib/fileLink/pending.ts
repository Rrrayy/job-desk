/**
 * write-ahead buffer（D8 第 2 层）—— 纯数据 + 纯函数，不碰 DOM / 文件 / storage。
 *
 * 解决的问题：`createWritable()` 的 `write()` 已经发出、`close()` 还没返回时，
 * 进程被杀 / 标签页被关 / 电脑断电。此时文件处于不确定状态，
 * 而用户以为「刚保存了」。没有 write-ahead，这一次编辑就凭空消失了。
 *
 * 协议：
 * 1. 写文件**之前**先落一条 `PendingWrite`（含 `contentHash`、`payload`、`createdAt`）；
 * 2. 写入成功 → 清掉；写入失败 → 保留，下次启动重放；
 * 3. 重放前重新读文件算 hash：
 *    - 与 `PendingWrite.contentHash` 一致 → 说明文件还是我们离开时那一版，可以重放；
 *    - 不一致 → **文件被外部改过，绝不重放**，改为生成冲突副本让用户决策；
 * 4. 连续 3 次重放失败 → `status: 'failed'`，保留 30 天供手动恢复。
 *
 * 为什么 `contentHash` 记的是「**写入前**文件的内容摘要」而不是「待写内容的摘要」：
 * 重放时要回答的问题是「文件还是我离开时那一版吗」，所以比对基准必须是
 * 写入前那一版。待写内容自己的摘要不需要存 —— payload 就在手边。
 */

export const PENDING_WRITE_TTL_DAYS = 30;
export const MAX_REPLAY_FAILURES = 3;

export interface PendingWrite {
  /** 写入前的文件内容摘要（hex） */
  contentHash: string;
  /** 待写入的完整文本 */
  payload: string;
  /** 排队创建的 ISO 时刻 */
  createdAt: string;
  status: 'pending' | 'failed';
  /** 已尝试重放的次数（含失败） */
  attempts: number;
  /** 最近一次失败原因，展示用 */
  lastError?: string;
  /** 最近一次失败时刻 */
  lastAttemptAt?: string;
}

export type ReplayDecision =
  | { action: 'replay' }
  | { action: 'conflict'; reason: string }
  | { action: 'drop'; reason: string }
  | { action: 'giveUp'; reason: string };

/**
 * 决定一条 PendingWrite 的命运。**纯函数**：hash 由调用方算好传进来。
 *
 * 顺序很重要：先判过期 / 放弃，再判内容一致性 ——
 * 一条 30 天前的写入，就算文件没变也不该再重放（用户早就不知道这是哪一版了）。
 * giveUp 排在 drop 之前：已放弃的那条要保留 30 天给人工恢复，不能被过期规则悄悄删掉。
 */
export function decideReplay(
  pending: PendingWrite,
  currentHash: string,
  nowIso: string,
): ReplayDecision {
  if (pending.status === 'failed') {
    return { action: 'giveUp', reason: '这条写入已连续失败，只能手动恢复' };
  }
  if (pending.attempts >= MAX_REPLAY_FAILURES) {
    return { action: 'giveUp', reason: `已连续失败 ${pending.attempts} 次，不再自动重试` };
  }
  const ageDays = (Date.parse(nowIso) - Date.parse(pending.createdAt)) / 86_400_000;
  if (!Number.isFinite(ageDays)) {
    return { action: 'drop', reason: '写入排队时间不可解析，无法判断新旧' };
  }
  if (ageDays > PENDING_WRITE_TTL_DAYS) {
    return { action: 'drop', reason: `排队已超过 ${PENDING_WRITE_TTL_DAYS} 天，不再自动重放` };
  }
  if (pending.contentHash !== currentHash) {
    return {
      action: 'conflict',
      reason: '文件在写入中断之后被外部修改过，直接重放会覆盖别人的改动',
    };
  }
  return { action: 'replay' };
}

/** 记录一次重放失败（纯函数：返回新的 PendingWrite，不改入参） */
export function markReplayFailed(pending: PendingWrite, error: string, nowIso: string): PendingWrite {
  const attempts = pending.attempts + 1;
  return {
    ...pending,
    attempts,
    lastError: error.slice(0, 200),
    lastAttemptAt: nowIso,
    status: attempts >= MAX_REPLAY_FAILURES ? 'failed' : 'pending',
  };
}

/** 序列化到 localStorage 用（pending 只是个字符串 key，不进主库） */
export function serializePending(pending: PendingWrite | null): string | null {
  if (!pending) return null;
  return JSON.stringify(pending);
}

/** 从 localStorage 读回；任何异常都当真（返回 null），绝不因为一条坏缓存拦住启动 */
export function parsePending(raw: string | null): PendingWrite | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const value = parsed as Record<string, unknown>;
    if (typeof value.contentHash !== 'string' || typeof value.payload !== 'string') return null;
    if (typeof value.createdAt !== 'string') return null;
    const attempts = typeof value.attempts === 'number' && value.attempts >= 0 ? Math.trunc(value.attempts) : 0;
    return {
      contentHash: value.contentHash,
      payload: value.payload,
      createdAt: value.createdAt,
      status: value.status === 'failed' ? 'failed' : 'pending',
      attempts,
      ...(typeof value.lastError === 'string' ? { lastError: value.lastError } : {}),
      ...(typeof value.lastAttemptAt === 'string' ? { lastAttemptAt: value.lastAttemptAt } : {}),
    };
  } catch {
    return null;
  }
}
