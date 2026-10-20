/**
 * 体积水位。
 *
 * 测量口径：`JSON.stringify(db).length` 的**字符数**（UTF-16 码元），与 PRD §D.4 一致。
 * 注意浏览器配额口径不一（Safari 更早抛 QuotaExceededError），所以这里只是**提示**，
 * 真正的兜底仍然是 saveDB 的 try/catch。
 */

import type { DB } from '../types';

export const BUDGET = {
  /** 超过就提示「接近上限，建议导出归档」 */
  warn: 3_500_000,
  /** 超过就拒绝写入，只允许导出 + 清理 */
  block: 4_500_000,
  /** 单字段上限，超出截断并提示（不静默丢） */
  limits: {
    questionText: 2000,
    myAnswer: 5000,
    overallNote: 3000,
    noteContent: 2000,
  },
} as const;

export type BudgetLevel = 'ok' | 'warn' | 'block';

/** 当前库的体积（字符数） */
export function measureDB(db: DB): number {
  try {
    return JSON.stringify(db).length;
  } catch {
    return 0;
  }
}

export function budgetLevelOf(size: number): BudgetLevel {
  if (size >= BUDGET.block) return 'block';
  if (size >= BUDGET.warn) return 'warn';
  return 'ok';
}

/** 截断到 limit 个字符，并告诉调用方是否发生了截断（截断必须 toast，不能静默） */
export function clampText(value: string, limit: number): { text: string; truncated: boolean } {
  if (typeof value !== 'string') return { text: '', truncated: false };
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: value.slice(0, limit), truncated: true };
}

/** 人类可读的体积文案：1.2 MB */
export function formatBytes(chars: number): string {
  const bytes = chars * 2; // UTF-16，中文占 2 字节
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
