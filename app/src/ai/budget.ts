/**
 * 输入体量的 token 估算（v0.10 / L1-9）。
 *
 * 为什么需要：v0.9 的截断全按**字符**数（`MODULE_CHARS=1600`、`PASTE_LIMIT=5000`），
 * 但模型的上下文窗口按 **token** 算。中文一个字大约 1 token、英文约 4 字符 1 token，
 * 同样 4000 字符的两段输入，token 量能差出一倍 —— 按字符设上限等于没有上限。
 *
 * 这是**估算**，不是分词器：产品不带 BPE 词表（那会平白多 100 KB 且随时过期）。
 * 用途只有两个：
 * 1. 预览弹层显示「约 N tokens」，让用户对成本有数；
 * 2. 超过 `CONTEXT_WARN_TOKENS` 时给一句预警（提示，不阻断 —— 真实窗口只有服务端知道）。
 *
 * 误差方向刻意偏**高**（宁可多提醒一次，也不要悄悄超窗换一个 400）。
 */

import type { ChatMessage } from './types';

/** 触发预警的估算量。7B 级本地模型常见窗口 8k，留出输出余量后取 6000 */
export const CONTEXT_WARN_TOKENS = 6000;

/** CJK 统一表意文字 + 常见中文标点（这些基本是 1 字 ≈ 1 token） */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;

/**
 * 估算一段文本的 token 数：
 * - CJK 字符按 1 token/字
 * - 其余字符按 1 token / 3.2 字符（比常见 4 稍紧，误差偏保守）
 * - 换行与连续空白单独计 1，避免大段排版噪声被算成 0
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK.test(char)) cjk += 1;
    else other += 1;
  }
  const lines = text.split('\n').length - 1;
  return Math.max(1, Math.round(cjk + other / 3.2) + Math.min(lines, 200));
}

/** 整组消息的估算量（system 提示也算钱，不能只算 user） */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateTokens(message.content) + 4;
  return total;
}

/** 是否超过预警线 */
export function isContextHeavy(tokens: number): boolean {
  return tokens >= CONTEXT_WARN_TOKENS;
}
