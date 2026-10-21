/**
 * 猎聘解析（2026-10-21 真机校准）。
 *
 * 两种形态：
 * - 「投递」列表：一条记录 = 岗位名与薪资挤在一行（「【华为实习生招聘】研发工... 300-500元/天」）
 *   + 公司名单独一行 + 地点标签行 + HR 行 + 完整时间行 + 状态角标（已查看/已投递/不合适）。
 *   顶部 Tab 行（「已投递 已查看 不合适 面试邀约」）含多个状态词，必须先丢，
 *   否则状态会被解析成一串 Tab 文案。
 * - 职位详情页：走 shared.ts 的 parseDetailLike，产出一条记录。
 *
 * 列表页只有一条真实样本（用户当前仅一条投递），启发式按此形态写；后续样本多了再放宽。
 */

import type { AdapterInput, AdapterResult, ParseContext } from '../types';
import {
  looksLikeDetailPage,
  parseDetailLike,
  parseListLike,
  SALARY_RE,
  splitLines,
} from '../shared';

/** 列表页导航噪声：页面标题与功能入口（注意：孤立状态角标「已查看」是状态来源，不能丢） */
const LIEPIN_NOISE =
  /^(投递|收藏|浏览|求职必备|猜你喜欢|查看全部|查看更多|加载更多)$/;

/** 一行里出现 ≥2 个状态/Tab 词 = Tab 行，不是记录 */
function isTabRow(line: string): boolean {
  const hits = line.match(/已投递|已查看|不合适|面试邀约|被查看|通过初筛|笔试|OFFER|offer/g);
  return hits !== null && hits.length >= 2;
}

/**
 * 投递列表预处理：
 * - 丢页面标题、Tab 行、孤立状态词行；
 * - 「岗位名 + 薪资」挤在同一行 → 拆成两行，否则整行会被当成薪资文本。
 */
export function normalizeDeliveryPage(text: string): string {
  const out: string[] = [];
  for (const line of splitLines(text)) {
    if (LIEPIN_NOISE.test(line) || isTabRow(line)) continue;

    const hit = SALARY_RE.exec(line);
    if (hit && hit.index > 0 && line.length <= 60) {
      // 岗位名（可能带「【…】」前缀与截断省略号）与薪资同行 → 拆开
      const title = line.slice(0, hit.index).replace(/[\s·|]+$/u, '').trim();
      const salary = hit[0].trim();
      if (title) {
        out.push(title);
        out.push(salary);
        continue;
      }
    }

    out.push(line);
  }
  return out.join('\n');
}

export function parseLiepinText(input: AdapterInput, ctx: ParseContext): AdapterResult {
  const text = input.text || '';
  if (looksLikeDetailPage(text)) return parseDetailLike(text, ctx.now);
  return parseListLike(normalizeDeliveryPage(text), ctx.now, { assumeCompanyFromFirstLine: true });
}
