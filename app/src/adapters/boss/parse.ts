/**
 * BOSS 直聘文本解析。
 *
 * 支持三种页面形态：
 * 1. 沟通/投递列表（zhipin.com/web/geek/chat|apply）——每条记录自带状态行与完整时间，
 *    直接交给 shared.ts 的通用管线。
 * 2. 求职记录页（App「我的 → 求职记录」，2026-10 真机校准）——结构与前者不同：
 *    - 页面头有一段固定噪声（标题/Tab/说明文字/「累计沟通职位数量N」）；
 *    - 日期只出现在**分组标题行**（「10月21日」），记录内只有「14:12」这种时刻；
 *    - 公司行带融资与规模（「同元软控 A轮 500-999人」）；
 *    - 地点行带周期标签（「苏州 苏州工业园区 湖东 5天/周 6个月 本科」）；
 *    - 沟通过 tab 里**没有状态行**。
 * 3. 职位详情页（含「职位详情」「立即投递」等特征词）→ shared.ts 的 parseDetailLike，
 *    产出恰好一条记录，lastContactAt 留空。
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
import {
  COMPANY_WITH_FUNDING_RE,
  SALARY_RE,
  looksLikeDetailPage,
  parseDetailLike,
  parseListLike,
  splitLines,
} from '../shared';

/** 求职记录页头部/导航噪声：整行命中即丢弃 */
const RECORD_PAGE_NOISE =
  /^(求职记录|重新统计|我看过|沟通过|交换过|面试|继续沟通|更多相似职位|查看详细分析|你的竞争力分析|当前记录仅自己可见.*|如果想查看其他记录.*|累计[\u4e00-\u9fa5]*职位数量\d+)$/;

/** 分组标题行：仅「10月21日」这种形态 */
const GROUP_DATE_RE = /^(\d{1,2})月(\d{1,2})日$/;

/** 地点行尾部标签：如「 5天/周 6个月 本科」 */
const LOCATION_TAGS_RE = /\s+\d+\s*天\s*\/\s*周\s.*$/;

/**
 * 求职记录**卡片**头（App 单卡片复制，2026-10-21 真机两例）：「杨琪 招聘者」「杨琪招聘者」。
 * 注意：**中间有没有空格都存在** —— 截图里的空格是两个 HTML 元素渲染出来的视觉间隙，
 * innerText 里经常没有。所以不能要求 \s+。
 * 这是卡片头噪声——招聘者姓名在产品里没有对应字段（裸姓名脱敏都做不到，见已知限制），
 * 唯一的害处是被当成公司名吞进待归类，所以整行丢弃。
 */
const CARD_RECRUITER_RE = /^.{0,12}(?:招聘者|猎头)$/;

/** 卡片地点在方括号里：「Agent 研发实习生 [杭州-萧山区·宁围]」→ 拆成岗位行 + 城市行 */
const BRACKET_CITY_RE = /[[〔【]\s*([^\]〕】]{2,30}?)\s*[\]〕】]/;

/**
 * 卡片公司行变体：公司名 + 行业 + 规模（无融资阶段），如
 * 「杭州芯流微澜智能科技 半导体/芯片 0-20人」。与 COMPANY_WITH_FUNDING_RE 的区别：
 * 中段不要求是融资词、末段不要求「N-M人」带下限——「0-20人」也命中。
 */
const COMPANY_WITH_INDUSTRY_RE =
  /^(.{2,20}?)\s+[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z/·、]*\s*\d+[-~－—]\d*人$/;

/** 行业+规模的**独立行**（公司名另起一行时）：「半导体/芯片0-20人」。整体丢弃 */
const INDUSTRY_SIZE_LINE_RE = /^[\u4e00-\u9fa5A-Za-z]+\/[\u4e00-\u9fa5A-Za-z/·、]*\d+[-~－—]\d*人$/;

/** 卡片薪资行的尾部标签：「300-310元/天 在校/应届 | 本科」——标签不是数据，丢弃 */
const SALARY_TAG_TOKENS = new Set([
  '在校', '应届', '往届', '本科', '硕士', '大专', '博士', '不限', '全职', '实习', '兼职',
]);

/**
 * 求职记录页预处理（含卡片形态）：
 * - 丢头部噪声行与卡片头（「杨琪 招聘者」）；
 * - 卡片头是块边界：其前插入空行，保证一张卡恰好一个块（chunkByBlankLines）；
 * - 把分组日期记住，下放到其后第一条时刻行（「14:12」→「10月21日 14:12」），
 *   否则通用管线会把裸时刻当成「今天」，跨分组的日期全错；
 * - 公司行剥离「融资阶段 + 规模」或「行业 + 规模」（两种真机形态），只留公司名；
 * - 方括号地点拆成独立城市行：「Agent 研发实习生 [杭州-萧山区·宁围]」；
 * - 薪资行剥离「在校/应届 | 本科」类标签，只留薪资本体；
 * - 地点行剥离「N天/周 N个月 学历」标签，否则超过 looksLikeCity 的长度上限。
 */
export function normalizeRecordPage(text: string): string {
  const out: string[] = [];
  let groupDate: string | null = null;

  for (const line of splitLines(text)) {
    if (RECORD_PAGE_NOISE.test(line)) continue;

    if (CARD_RECRUITER_RE.test(line)) {
      // 卡片边界：前面已有内容就隔一个空行，让分块器在这里切开
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      continue;
    }

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

    const withIndustry = COMPANY_WITH_INDUSTRY_RE.exec(line);
    if (withIndustry) {
      out.push(withIndustry[1]);
      continue;
    }

    // 「半导体/芯片0-20人」独立行：不是数据，直接丢。
    // 不丢的话它的「0-20」会被通用管线当薪资形态抢走，真薪资反而丢了。
    if (INDUSTRY_SIZE_LINE_RE.test(line)) continue;

    // 方括号地点：拆成「岗位行 + 城市行」两行
    const bracket = BRACKET_CITY_RE.exec(line);
    if (bracket) {
      const rest = line.replace(BRACKET_CITY_RE, ' ').replace(/\s+/g, ' ').trim();
      if (rest) out.push(rest);
      out.push(bracket[1]);
      continue;
    }

    // 薪资 + 标签：标签全是学历/届别词时只留薪资本体
    const salary = SALARY_RE.exec(line);
    if (salary) {
      const rest = line.replace(salary[0], ' ');
      const tokens = rest.split(/[|/、\s]+/).filter(Boolean);
      if (tokens.every((token) => SALARY_TAG_TOKENS.has(token))) {
        out.push(salary[0].replace(/\s+/g, ''));
        continue;
      }
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
  if (looksLikeDetailPage(raw)) return parseDetailLike(raw, ctx.now);
  // 形态判定：分组日期行 / 融资+规模行 / 卡片头 → 求职记录页；否则走原管线
  const isRecordPage = splitLines(raw).some(
    (line) => GROUP_DATE_RE.test(line) || COMPANY_WITH_FUNDING_RE.test(line) || CARD_RECRUITER_RE.test(line),
  );
  const text = isRecordPage ? normalizeRecordPage(raw) : raw;
  return parseListLike(text, ctx.now);
}
