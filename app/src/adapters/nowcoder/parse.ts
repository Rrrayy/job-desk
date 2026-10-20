/** 牛客「我的投递」解析：列表里常有「笔试」「待面试」等牛客特有文案。 */

import type { AdapterInput, AdapterResult, ParseContext } from '../types';
import { parseListLike } from '../shared';

export function parseNowcoderText(input: AdapterInput, ctx: ParseContext): AdapterResult {
  return parseListLike(input.text || '', ctx.now, { assumeCompanyFromFirstLine: true });
}
