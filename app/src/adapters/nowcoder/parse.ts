/**
 * 牛客解析。
 *
 * 两种形态：
 * - 「我的投递」列表：常有「笔试」「待面试」等牛客特有文案；
 * - 职位详情页（2026-10-21 真机校准）：公司名常出现在 HR 行首段
 *   （「华为HUAWEI · …部HR」），走 shared.ts 的 parseDetailLike。
 */

import type { AdapterInput, AdapterResult, ParseContext } from '../types';
import { looksLikeDetailPage, parseDetailLike, parseListLike } from '../shared';

export function parseNowcoderText(input: AdapterInput, ctx: ParseContext): AdapterResult {
  const text = input.text || '';
  if (looksLikeDetailPage(text)) return parseDetailLike(text, ctx.now);
  return parseListLike(text, ctx.now, { assumeCompanyFromFirstLine: true });
}
