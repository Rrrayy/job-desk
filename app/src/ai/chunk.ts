/**
 * 长文本分块（v0.10 / L2-6）。
 *
 * 只服务于「面经整段拆题」（d14-bulk）：这道工序天然可分 —— 题干之间相互独立，
 * 切块不会像「简历诊断」那样破坏整体视角，所以不给别的场景用。
 *
 * 切分顺序：段落（空行）→ 行 → 字符硬切。保证返回的每块都 ≤ 预算，
 * 且**不丢字符**（拼回去与原文等价，除了被 trim 掉的段落首尾空白）。
 *
 * 为什么按 token 估算而不是字符：中文 4000 字 ≈ 4000 token，英文 4000 字符 ≈ 1250 token，
 * 按字符切会让中文用户撞上下文窗口，而英文用户被无谓地多切几刀。
 */

import { estimateTokens } from './budget';

/** 单块预算。8k 窗口的常见本地模型留出 prompt 与输出余量后取 4000 */
export const BULK_CHUNK_TOKENS = 4000;

/** 单行硬切：按比例估算该切多少字符，最多试几轮就必然收敛 */
function hardSplit(text: string, maxTokens: number): string[] {
  const out: string[] = [];
  let buffer = '';
  for (const line of text.split('\n')) {
    const candidate = buffer ? `${buffer}\n${line}` : line;
    if (estimateTokens(candidate) <= maxTokens) {
      buffer = candidate;
      continue;
    }
    if (buffer.trim()) {
      out.push(buffer);
    }
    let rest = line;
    while (estimateTokens(rest) > maxTokens) {
      const ratio = maxTokens / estimateTokens(rest);
      const take = Math.max(1, Math.floor(rest.length * ratio));
      out.push(rest.slice(0, take));
      rest = rest.slice(take);
    }
    buffer = rest;
  }
  if (buffer.trim()) out.push(buffer);
  return out;
}

/**
 * 按预算切块。文本本身不超预算时原样返回**一个元素**（调用方据此判断要不要走分块路径）。
 */
export function splitByTokens(text: string, maxTokens: number = BULK_CHUNK_TOKENS): string[] {
  if (!text.trim()) return [];
  if (estimateTokens(text) <= maxTokens) return [text];

  const chunks: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const paragraph of text.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (estimateTokens(candidate) <= maxTokens) {
      current = candidate;
      continue;
    }
    flush();
    if (estimateTokens(paragraph) <= maxTokens) {
      current = paragraph;
      continue;
    }
    // 单段超限：按行切，单行再超限就按字符硬切
    for (const piece of hardSplit(paragraph, maxTokens)) {
      if (estimateTokens(piece) <= maxTokens) chunks.push(piece);
      else chunks.push(...hardSplit(piece, maxTokens));
    }
  }
  flush();
  return chunks.length > 0 ? chunks : [text];
}
