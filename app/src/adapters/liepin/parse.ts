/**
 * 猎聘解析（v0.5.1 后新增平台，随 v0.6 发布）。
 *
 * 目前校准的形态（2026-10-21 真机）：职位详情页——
 * - 第一行常是「岗位名 薪资」挤在同一行（「C++实习开发工程师 100-150元/天」）；
 * - 公司全名在「公司信息」标题行的下一行；
 * - 城市形如「南京-秣陵」。
 * 列表页结构尚未在真实登录页验证，走通用兜底管线。
 */

import type { AdapterInput, AdapterResult, ParseContext } from '../types';
import { looksLikeDetailPage, parseDetailLike, parseListLike } from '../shared';

export function parseLiepinText(input: AdapterInput, ctx: ParseContext): AdapterResult {
  const text = input.text || '';
  if (looksLikeDetailPage(text)) return parseDetailLike(text, ctx.now);
  return parseListLike(text, ctx.now, { assumeCompanyFromFirstLine: true });
}
