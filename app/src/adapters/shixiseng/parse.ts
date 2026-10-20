/** 实习僧「我的投递」解析：结构与 BOSS 类似，状态文案略有差异（含「已查看」「邀请面试」）。 */

import type { AdapterInput, AdapterResult, ParseContext } from '../types';
import { parseListLike } from '../shared';

export function parseShixisengText(input: AdapterInput, ctx: ParseContext): AdapterResult {
  return parseListLike(input.text || '', ctx.now, { assumeCompanyFromFirstLine: true });
}
