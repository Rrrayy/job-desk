/**
 * 实习僧解析。
 *
 * 两种形态：
 * - 「我的投递」列表：结构与 BOSS 类似，状态文案略有差异（含「已查看」「邀请面试」）；
 * - 职位详情页（2026-10-21 真机校准）：含「职位详情」「投递简历」等特征词，
 *   走 shared.ts 的 parseDetailLike，产出一条记录；详情页的「截止时间」
 *   是投递窗口不是联系事件，绝不写进 lastContactAt。
 */

import type { AdapterInput, AdapterResult, ParseContext } from '../types';
import { looksLikeDetailPage, parseDetailLike, parseListLike } from '../shared';

export function parseShixisengText(input: AdapterInput, ctx: ParseContext): AdapterResult {
  const text = input.text || '';
  if (looksLikeDetailPage(text)) return parseDetailLike(text, ctx.now);
  return parseListLike(text, ctx.now, { assumeCompanyFromFirstLine: true });
}
