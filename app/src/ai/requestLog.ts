/**
 * RequestLog 写入侧（v0.8 / T03，ARCH §2.1）。
 *
 * ★ 隐私红线（PRD 验收 13）：**永远不记录请求体与响应体原文**。
 *   日志行只有元数据 + 发送字段指纹（SHA-256），指纹不可逆，
 *   用来回答「上次到底发没发过同样的字段组合」，不是用来还原内容的。
 *   `exportJSON` 已在 lib/storage.ts 剥离 requestLog，日志不随备份扩散。
 *
 * 函数是纯的：构造 entry / 截断列表，实际 push 由调用方的 mutate recipe 完成。
 */

import type { RequestLog } from '../types';
import { uid } from '../lib/util';
import { sha256Hex } from '../lib/selfSnapshot';

/** 日志上限：超出丢最旧（与暂存区 200 条同一手法，防长会话把库撑爆） */
export const REQUEST_LOG_LIMIT = 200;

/**
 * 确认后发送字段的指纹：键名排序 → JSON 规范化 → SHA-256。
 * 键序无关，同内容必同指纹；值一个字符不同指纹必变。
 */
export async function fieldsFingerprint(fields: Record<string, string>): Promise<string> {
  const canonical: Record<string, string> = {};
  for (const key of Object.keys(fields).sort()) canonical[key] = fields[key];
  const digest = await sha256Hex(new TextEncoder().encode(JSON.stringify(canonical)));
  // sha256Hex 在非安全上下文返回 ''：日志仍要可区分，用固定占位而不是空串
  return digest || 'unavailable';
}

export interface RequestLogInput {
  pluginId: string;
  baseUrl: string;
  model: string;
  sentFieldsHash: string;
  status: RequestLog['status'];
  errorCode?: string;
}

/** 构造一条日志行（含 id/timestamp）；原文字段在类型上就不存在 */
export function buildRequestLogEntry(input: RequestLogInput, nowIso: string): RequestLog {
  const entry: RequestLog = {
    id: uid('rlog'),
    timestamp: nowIso,
    pluginId: input.pluginId,
    baseUrl: input.baseUrl,
    model: input.model,
    sentFieldsHash: input.sentFieldsHash,
    status: input.status,
  };
  if (input.errorCode) entry.errorCode = input.errorCode;
  return entry;
}

/** 超限截断：保最新 REQUEST_LOG_LIMIT 条 */
export function capRequestLog(logs: RequestLog[], limit: number = REQUEST_LOG_LIMIT): RequestLog[] {
  if (logs.length <= limit) return logs;
  return logs.slice(logs.length - limit);
}
