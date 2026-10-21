/**
 * BOSS 直聘文本解析。
 *
 * 支持两种页面形态：
 * 1. 沟通/投递列表（zhipin.com/web/geek/chat|apply）——每条记录自带状态行与完整时间，
 *    直接交给 shared.ts 的通用管线。
 * 2. 求职记录页（App「我的 → 求职记录」，2026-10 真机校准）——结构与前者不同：
 *    - 页面头有一段固定噪声（标题/Tab/说明文字/「累计沟通职位数量N」）；
 *    - 日期只出现在**分组标题行**（「10月21日」），记录内只有「14:12」这种时刻；
 *    - 公司行带融资与规模（「同元软控 A轮 500-999人」）；
 *    - 地点行带周期标签（「苏州 苏州工业园区 湖东 5天/周 6个月 本科」）；
 *    - 沟通过 tab 里**没有状态行**。
 *
 * 形态 2 在交给通用管线前先做一遍**纯函数**预处理（normalizeRecordPage），
 * 预处理只发生在 BOSS 适配器内部——共享引擎不加平台 if（架构 D-05）。
 *
 * 已知限制（同时写进 README.md 与 docs/adapters/boss.md）：
 * - 拿不到 externalId（纯文本没有 href）→ 去重靠 matchKey + 模糊匹配；
 * - 拿不到「最后一条消息是谁发的」→「沟通中」一律按 chatting / high 处理（架构 §8-歧义 3）；
 * - 求职记录页「沟通过」tab 不显示状态 → status 为 undefined、置信度 low，诚实降级；
 * - 用户复制的是当前渲染出来的部分，虚拟滚动会截断，「识别 N 条」小于总数是正常的。
 */

import type { AdapterInput, AdapterResult, ParseContext } from '../types';
import { parseListLike, splitLines } from '../shared';

/** 求职记录页头部/导航噪声：整行命中即丢弃 */
const RECORD_PAGE_NOISE =
  /^(求职记录|重新统计|我看过|沟通过|交换过|面试|继续沟通|更多相似职位|查看详细分析|你的竞争力分析|当前记录仅自己可见.*|如果想查看其他记录.*|累计[\u4e00-\u9fa5]*职位数量\d+)$/;

/** 分组标题行：仅「10月21日」这种形态 */
const GROUP_DATE_RE = /^(\d{1,2})月(\d{1,2})日$/;

/** 公司行：公司名 + 融资阶段 + 规模，如「同元软控 A轮 500-999人」 */
const COMPANY_WITH_FUNDING_RE =
  /^(.{2,20}?)\s+((?:A\+?轮|[BCD]轮|天使轮|已上市|不需要融资|未融资|战略投资)\s+[\d－~-]+人)$/;

/** 地点行尾部标签：如「 5天/周 6个月 本科」 */
const LOCATION_TAGS_RE = /\s+\d+\s*天\s*\/\s*周\s.*$/;

/**
 * 求职记录页预处理：
 * - 丢头部噪声行；
 * - 把分组日期记住，下放到其后第一条时刻行（「14:12」→「10月21日 14:12」），
 *   否则通用管线会把裸时刻当成「今天」，跨分组的日期全错；
 * - 公司行剥离「融资阶段 + 规模」，只留公司名；
 * - 地点行剥离「N天/周 N个月 学历」标签，否则超过 looksLikeCity 的长度上限。
 */
export function normalizeRecordPage(text: string): string {
  const out: string[] = [];
  let groupDate: string | null = null;

  for (const line of splitLines(text)) {
    if (RECORD_PAGE_NOISE.test(line)) continue;

    const group = GROUP_DATE_RE.exec(line);
    if (group) {
      groupDate = line;
      continue;
    }

    if (/^\d{1,2}:\d{2}$/.test(line)) {
      // 求职记录页：裸时刻行 + 当前分组日期 → 补全成「10月21日 14:12」
      out.push(groupDate ? `${groupDate} ${line}` : line);
      continue;
    }

    const company = COMPANY_WITH_FUNDING_RE.exec(line);
    if (company) {
      out.push(company[1]);
      continue;
    }

    if (LOCATION_TAGS_RE.test(line)) {
      out.push(line.replace(LOCATION_TAGS_RE, ''));
      continue;
    }

    out.push(line);
  }
  return out.join('\n');
}

export function parseBossText(input: AdapterInput, ctx: ParseContext): AdapterResult {
  const raw = input.text || '';
  // 形态判定：含分组日期行或「融资阶段+规模」行 → 求职记录页；否则走原管线
  const isRecordPage = splitLines(raw).some(
    (line) => GROUP_DATE_RE.test(line) || COMPANY_WITH_FUNDING_RE.test(line),
  );
  const text = isRecordPage ? normalizeRecordPage(raw) : raw;
  return parseListLike(text, ctx.now);
}
