/**
 * 适配器共用的「行启发式」工具集 + 通用列表解析管线。
 *
 * 为什么要有这个文件：BOSS / 实习僧 / 牛客 / 通用表格四个适配器的页面结构不同，
 * 但「日期怎么读」「哪行像状态」「哪行像薪资」「怎么把一段文本切成一条条记录」
 * 是同一套启发式。复制四份必然腐烂，所以集中在这里。
 *
 * 这里**只放纯函数**：不 import React / storage / DOM，不读 Date.now()（时间全靠 nowIso 注入）。
 */

import type { AdapterResult, Confidence, NormalizedRecord, UnparsedItem } from './types';
import { overallOf } from './types';

/** 一次抓取里可能出现的时间词 */
const RELATIVE_DAYS: Record<string, number> = {
  今天: 0,
  昨天: 1,
  前天: 2,
  大前天: 3,
};

/** 平台状态文案的正则集合（只用来「识别这一行是不是状态」，不负责映射） */
export const STATUS_HINTS: RegExp[] = [
  /邀请面试|邀你面试|约面试/,
  /已面试|面试完成|面试已结束/,
  /已录用|发放\s*offer|已发\s*offer/i,
  /已入职/,
  /不合适|已结束|不符合|暂不匹配/,
  /已投递|简历已送达|已送达|已查看/,
  /沟通中/,
  /待沟通|未读|新消息/,
];

/**
 * 公司行：公司名 + 融资阶段 + 规模，如「同元软控 A轮 500-999人」（2026-10 真机形态）。
 * BOSS 求职记录页与详情页共用，所以放在共享层。
 */
export const COMPANY_WITH_FUNDING_RE =
  /^(.{2,20}?)\s+((?:A\+?轮|[BCD]轮|天使轮|已上市|不需要融资|未融资|战略投资)\s+[\d－~-]+人)$/;

/** 城市词（与 normalize.ts 共用同一份语义，但这里只用于识别「这一行像城市」） */
export const CITY_WORDS = [
  '北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京', '西安', '苏州', '天津', '重庆',
  '长沙', '郑州', '合肥', '厦门', '福州', '济南', '青岛', '大连', '沈阳', '哈尔滨', '长春', '昆明',
  '南昌', '贵阳', '南宁', '太原', '石家庄', '兰州', '乌鲁木齐', '呼和浩特', '海口', '珠海', '东莞',
  '佛山', '无锡', '宁波', '香港', '澳门', '台北',
];

/** 岗位名里几乎必然出现的词 */
const JOB_HINTS =
  /实习|工程师|开发|前端|后端|客户端|服务端|算法|测试|产品|运营|设计|数据|架构|全栈|研究员|项目管理|市场|人力/;

/** 薪资形态：200-300/天、15-25K、3000元/月、100-150元/天（含全角/短破折号连接符） */
export const SALARY_RE =
  /\d+(?:\.\d+)?\s*[-~至–—]\s*\d+(?:\.\d+)?\s*(?:[kK千万])?(?:\s*元)?(?:\s*\/\s*[天月年])?|\d+\s*元\s*\/\s*[天月]|\d+\s*[kK]\s*[-~至–—]\s*\d+\s*[kK]/;

/** 公司名常见的收尾（用来判断「这一行像公司名」） */
const COMPANY_TAIL =
  /(公司|集团|科技|网络|信息|技术|银行|证券|保险|传媒|文化|教育|医疗|汽车|电子|控股|有限|工作室|研究院|实验室)$/;

/** 明显不是内容的行（导航、按钮、页码） */
const NOISE_RE =
  /^(首页|我的|消息|搜索|筛选|更多|加载更多|没有更多|全部|返回|取消|确定|分享|举报|置顶|删除|收起|展开|查看全部|\d+\/\d+|第\s*\d+\s*页)$/;

export function splitLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\u00a0/g, ' ').trim())
    .filter((line) => line.length > 0 && !NOISE_RE.test(line));
}

export function looksLikeStatus(line: string): boolean {
  return STATUS_HINTS.some((re) => re.test(line));
}

export function looksLikeSalary(line: string): boolean {
  return SALARY_RE.test(line);
}

export function looksLikeCity(line: string): boolean {
  return CITY_WORDS.some((city) => line.startsWith(city)) && line.length <= 24;
}

export function looksLikeJobTitle(line: string): boolean {
  if (line.length > 40) return false;
  return JOB_HINTS.test(line);
}

export function looksLikeCompany(line: string): boolean {
  if (line.length < 2 || line.length > 40) return false;
  if (looksLikeJobTitle(line) || looksLikeStatus(line) || looksLikeSalary(line)) return false;
  return COMPANY_TAIL.test(line) || /^[\u4e00-\u9fa5A-Za-z0-9（）()·.-]{2,20}$/.test(line);
}

interface DateHit {
  /** ISO 时间 */
  iso: string;
  /** 是否带具体时刻（只有日期时为 false，用来决定置信度） */
  hasTime: boolean;
}

const pad2 = (value: number): string => `${value}`.padStart(2, '0');

/** 把「3月12日 10:20」「昨天」「刚刚」「2025-03-12」解析成 ISO；解析不出返回 null */
export function parsePlatformTime(token: string, nowIso: string): DateHit | null {
  const raw = token.trim();
  if (!raw) return null;
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) return null;

  if (/^刚刚$/.test(raw) || /^刚才$/.test(raw)) {
    return { iso: now.toISOString(), hasTime: true };
  }

  for (const key of Object.keys(RELATIVE_DAYS)) {
    const offset = RELATIVE_DAYS[key];
    if (!raw.includes(key)) continue;
    const time = /(\d{1,2}):(\d{2})/.exec(raw);
    const date = new Date(now.getTime());
    date.setDate(date.getDate() - offset);
    if (time) date.setHours(Number(time[1]), Number(time[2]), 0, 0);
    return { iso: date.toISOString(), hasTime: Boolean(time) };
  }

  const full = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(raw);
  if (full) {
    const date = new Date(
      Number(full[1]),
      Number(full[2]) - 1,
      Number(full[3]),
      full[4] ? Number(full[4]) : 9,
      full[5] ? Number(full[5]) : 0,
      0,
      0,
    );
    if (Number.isNaN(date.getTime())) return null;
    return { iso: date.toISOString(), hasTime: Boolean(full[4]) };
  }

  const monthDay = /(\d{1,2})\s*[月\-/]\s*(\d{1,2})\s*日?(?:[ T](\d{1,2}):(\d{2}))?/.exec(raw);
  if (monthDay) {
    const month = Number(monthDay[1]);
    const day = Number(monthDay[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(
      now.getFullYear(),
      month - 1,
      day,
      monthDay[3] ? Number(monthDay[3]) : 9,
      monthDay[4] ? Number(monthDay[4]) : 0,
      0,
      0,
    );
    // 未来的月日 → 一定是去年（平台不会给你未来的联系时间）
    if (date.getTime() > now.getTime() + 24 * 3600 * 1000) date.setFullYear(date.getFullYear() - 1);
    return { iso: date.toISOString(), hasTime: Boolean(monthDay[3]) };
  }

  const timeOnly = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (timeOnly) {
    const hour = Number(timeOnly[1]);
    const minute = Number(timeOnly[2]);
    if (hour > 23 || minute > 59) return null;
    const date = new Date(now.getTime());
    date.setHours(hour, minute, 0, 0);
    if (date.getTime() > now.getTime() + 60 * 1000) date.setDate(date.getDate() - 1);
    return { iso: date.toISOString(), hasTime: true };
  }

  return null;
}

/** 把一行里的日期片段抠出来（整行可能就是日期，也可能夹在状态文案后面） */
export function extractTime(line: string, nowIso: string): DateHit | null {
  const direct = parsePlatformTime(line, nowIso);
  if (direct) return direct;
  const candidate =
    /(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2})?|\d{1,2}\s*[月\-/]\s*\d{1,2}\s*日?(?:[ T]?\d{1,2}:\d{2})?|\d{1,2}:\d{2}|刚刚|昨天|前天|今天)/.exec(
      line,
    );
  if (!candidate) return null;
  return parsePlatformTime(candidate[1], nowIso);
}

/** 一行里是不是只有时间（这种行通常是记录的分隔符） */
export function isTimeOnlyLine(line: string, nowIso: string): boolean {
  const hit = extractTime(line, nowIso);
  if (!hit) return false;
  return line.replace(/\s/g, '').length <= 24;
}

/** 去掉行首的 emoji / 圆点 / 序号，避免公司名带上装饰符 */
export function stripDecorations(line: string): string {
  return line
    .replace(/^[\s•·●○▪▫◦※*\-—–|]+/u, '')
    .replace(/^[\u{1f300}-\u{1faff}\u2600-\u27bf]+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 截断到 n 个字符，用于 rawSnippet */
export function clampSnippet(text: string, n = 500): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= n ? oneLine : `${oneLine.slice(0, n)}…`;
}

/** 置信度取小 */
export function lowerConfidence(a: Confidence, b: Confidence): Confidence {
  const rank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
  return rank[a] <= rank[b] ? a : b;
}

/** 年-月-日 → YYYY-MM-DD（本地） */
export function isoToDatePart(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/* ==================== 通用「列表页文本 → 记录」管线 ==================== */

export interface Chunk {
  lines: string[];
}

/** 空行分块：BOSS 沟通列表 / 实习僧投递列表的 innerText 常见形态 */
export function chunkByBlankLines(text: string): Chunk[] {
  // 注意：只保留 >=1 行 —— 单行块（例如「系统消息：…」）也必须进入解析，
  // 否则它会静默消失，直接违反「解析失败的条目必须落进待归类」这条 P0。
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((block) => splitLines(block))
    .filter((lines) => lines.length >= 1)
    .map((lines) => ({ lines }));
}

/** 时间行收尾分块：没有空行时，用「一条记录必有一个时间」这个事实来切 */
export function chunkByTrailingTime(text: string, nowIso: string): Chunk[] {
  const lines = splitLines(text);
  const chunks: Chunk[] = [];
  let buffer: string[] = [];
  for (const line of lines) {
    buffer.push(line);
    if (isTimeOnlyLine(line, nowIso) && buffer.length >= 2) {
      chunks.push({ lines: buffer });
      buffer = [];
    }
  }
  if (buffer.length >= 1) chunks.push({ lines: buffer });
  return chunks;
}

export interface GenericOptions {
  /** 公司名命中这些后缀时置信度给 high */
  companyTail?: RegExp;
  /** 缺省 medium；用于「这一行像公司名但没有任何特征」的场景 */
  assumeCompanyFromFirstLine?: boolean;
  /** 期望的字段顺序提示：某些平台第一行是公司，第二行是岗位 */
  companyFirst?: boolean;
}

const DEFAULT_COMPANY_TAIL = COMPANY_TAIL;

function parseChunk(
  chunk: Chunk,
  nowIso: string,
  options: GenericOptions,
): { record: NormalizedRecord } | { reason: string; snippet: string } {
  const snippet = clampSnippet(chunk.lines.join(' / '));
  const used = new Set<number>();
  const tail = options.companyTail ?? DEFAULT_COMPANY_TAIL;

  let status: string | undefined;
  let lastContactAt: string | undefined;
  let timeHasClock = false;
  let salaryText: string | undefined;
  let city: string | undefined;
  let jobTitle: string | undefined;

  for (let i = 0; i < chunk.lines.length; i += 1) {
    const line = chunk.lines[i];
    if (status === undefined && looksLikeStatus(line)) {
      status = line.replace(/\s+/g, '');
      used.add(i);
      continue;
    }
    if (lastContactAt === undefined) {
      const hit = extractTime(line, nowIso);
      if (hit) {
        lastContactAt = hit.iso;
        timeHasClock = hit.hasTime;
        used.add(i);
        continue;
      }
    }
    if (salaryText === undefined && looksLikeSalary(line)) {
      salaryText = line.trim();
      used.add(i);
      continue;
    }
    if (city === undefined && looksLikeCity(line)) {
      city = line.split(/[·\s|/-]/)[0];
      used.add(i);
      continue;
    }
    if (jobTitle === undefined && looksLikeJobTitle(line)) {
      jobTitle = stripDecorations(line);
      used.add(i);
    }
  }

  let companyName: string | undefined;
  for (let i = 0; i < chunk.lines.length; i += 1) {
    if (used.has(i)) continue;
    const line = stripDecorations(chunk.lines[i]);
    if (!line || line.length > 40) continue;
    if (!looksLikeCompany(line) && !(options.assumeCompanyFromFirstLine && i === 0)) continue;
    companyName = line;
    used.add(i);
    break;
  }

  if (!companyName) {
    return { reason: '这一行没有公司名', snippet };
  }

  const confidence: Partial<Record<keyof NormalizedRecord, Confidence>> = {
    companyName: tail.test(companyName) ? 'high' : 'medium',
    jobTitle: jobTitle ? 'high' : 'low',
    status: status ? 'high' : 'low',
    lastContactAt: lastContactAt ? (timeHasClock ? 'high' : 'medium') : 'low',
  };

  return {
    record: {
      companyName,
      jobTitle,
      city,
      status,
      platformStatusText: status,
      lastContactAt,
      salaryText,
      rawSnippet: snippet,
      confidence,
      overall: overallOf(confidence),
    },
  };
}

/**
 * 把一段列表页纯文本解析成记录。
 * 分块策略：优先空行分块，空行不可靠时用「时间行收尾」；谁解出的公司名多就用谁。
 */
export function parseListLike(
  text: string,
  nowIso: string,
  options: GenericOptions = {},
): { records: NormalizedRecord[]; unparsed: UnparsedItem[] } {
  if (!text.trim()) {
    return { records: [], unparsed: [{ rawSnippet: '', reason: '粘贴区是空的，先把页面整页复制过来' }] };
  }

  const hasCompany = (chunks: Chunk[]): number =>
    chunks.filter((chunk) => chunk.lines.some((line) => looksLikeCompany(line))).length;

  const blank = chunkByBlankLines(text);
  const timed = chunkByTrailingTime(text, nowIso);
  let chunks = blank;
  if (hasCompany(timed) > hasCompany(blank) || (hasCompany(timed) === hasCompany(blank) && timed.length < blank.length)) {
    chunks = timed;
  }
  if (chunks.length === 0) {
    return {
      records: [],
      unparsed: [{ rawSnippet: clampSnippet(text), reason: '没认出任何一条记录，这可能不是列表页' }],
    };
  }

  const records: NormalizedRecord[] = [];
  const unparsed: UnparsedItem[] = [];
  for (const chunk of chunks) {
    const result = parseChunk(chunk, nowIso, options);
    if ('record' in result) records.push(result.record);
    else unparsed.push({ rawSnippet: result.snippet, reason: result.reason });
  }
  return { records, unparsed };
}

/* ==================== 详情页解析（2026-10-21 真机校准后新增） ==================== */

/**
 * 详情页特征词：列表页没有、详情页必有的文案。
 * 用户从手机 App 复制整页职位详情时走这条通道，产出**恰好一条**记录。
 */
export const DETAIL_PAGE_HINTS: RegExp =
  /职位详情|职位介绍|岗位职责|公司信息|立即投递|投递简历|职位亮点|投递要求|任职要求/;

/** 详情页按钮 / 导航 / 装饰行（注意：「公司信息」是分节标题，详情解析要靠它定位公司名，不能丢） */
const DETAIL_NOISE =
  /^(职位详情|职位详情页|投递简历|立即投递|聊一聊|收藏|分享|举报|查看全部|立即优化|猜你喜欢|求职必备|问大家|反馈快|已认证|一周前在线|刚刚在线|职位亮点|投递要求|职位介绍|工作地点|简历要求|立即体验|立即定制|相关推荐|看了又看)$/;

export function looksLikeDetailPage(text: string): boolean {
  return DETAIL_PAGE_HINTS.test(text);
}

/** HR 行：如「华为HUAWEI · 服务与软件研发管理部HR」——中段之前是公司名 */
const HR_LINE_RE = /^(.{2,20}?)\s*·\s*.{2,40}?(?:HR|经理|主管|专员|总监|顾问)$/u;

/**
 * 详情页纯文本 → 一条记录。
 *
 * 与列表页的本质区别：详情页**没有状态行**、没有「最后联系时间」——
 * 所以 lastContactAt 一律 undefined（绝不用「90天前更新」「截止时间」凑数），
 * 状态留空、置信度诚实降级，去重交给同步引擎的 matchKey + 模糊匹配。
 *
 * 公司名按可靠度递减取第一命中的：
 * 1. 「公司信息」标题行的下一行（猎聘等有明确分节的页面）；
 * 2. HR 行首段（「华为HUAWEI · …部HR」→「华为HUAWEI」，牛客等）；
 * 3. 公司名 + 融资 + 规模 行（BOSS 详情页）；
 * 4. 第一行像公司名的行（实习僧等）。
 */
export function parseDetailLike(
  text: string,
  _nowIso: string,
  options: { companyTail?: RegExp } = {},
): AdapterResult {
  if (!text.trim()) {
    return { records: [], unparsed: [{ rawSnippet: '', reason: '粘贴区是空的，先把页面整页复制过来' }] };
  }
  const snippet = clampSnippet(text);
  const raw = splitLines(text).filter((line) => !DETAIL_NOISE.test(line));
  const used = new Set<number>();

  let company: string | undefined;
  let jobTitle: string | undefined;
  let city: string | undefined;
  let salaryText: string | undefined;

  // 1. 「公司信息」标题行的下一行
  for (let i = 0; i < raw.length; i += 1) {
    if (!/^公司信息$/.test(raw[i])) continue;
    used.add(i);
    for (let j = i + 1; j < raw.length && j <= i + 2; j += 1) {
      const candidate = stripDecorations(raw[j]);
      if (candidate.length >= 2 && candidate.length <= 40) {
        company = candidate;
        used.add(j);
        break;
      }
    }
    break;
  }

  // 2. HR 行首段
  if (!company) {
    for (let i = 0; i < raw.length; i += 1) {
      const head = HR_LINE_RE.exec(stripDecorations(raw[i]))?.[1];
      if (head && !looksLikeJobTitle(head)) {
        company = head;
        used.add(i);
        break;
      }
    }
  }

  // 3. 公司名 + 融资 + 规模
  if (!company) {
    for (let i = 0; i < raw.length; i += 1) {
      const hit = COMPANY_WITH_FUNDING_RE.exec(raw[i]);
      if (hit) {
        company = hit[1];
        used.add(i);
        break;
      }
    }
  }

  // 4. 第一行像公司名的行
  if (!company) {
    for (let i = 0; i < raw.length; i += 1) {
      const candidate = stripDecorations(raw[i]);
      if (looksLikeCompany(candidate)) {
        company = candidate;
        used.add(i);
        break;
      }
    }
  }

  // 薪资：第一处薪资形态（可能和岗位名同一行，猎聘就是这样）
  for (let i = 0; i < raw.length; i += 1) {
    const hit = SALARY_RE.exec(raw[i]);
    if (!hit) continue;
    salaryText = hit[0].replace(/\s+/g, '');
    used.add(i);
    if (!jobTitle) {
      const rest = raw[i].replace(hit[0], ' ').replace(/[\s·|]+/g, ' ').trim();
      if (rest && rest.length <= 40 && looksLikeJobTitle(rest)) jobTitle = rest;
    }
    break;
  }

  // 岗位名：第一个像岗位的行
  if (!jobTitle) {
    for (let i = 0; i < raw.length; i += 1) {
      const candidate = stripDecorations(raw[i]);
      if (candidate.length <= 40 && looksLikeJobTitle(candidate)) {
        jobTitle = candidate;
        used.add(i);
        break;
      }
    }
  }

  // 城市：第一个以城市词开头且足够短的行（「南京-秣陵」「西安 5天/周 …」）
  for (let i = 0; i < raw.length; i += 1) {
    if (used.has(i)) continue;
    if (looksLikeCity(raw[i])) {
      city = raw[i].split(/[·\s|/-]/)[0];
      used.add(i);
      break;
    }
  }

  if (!company) {
    return { records: [], unparsed: [{ rawSnippet: snippet, reason: '这一行没有公司名' }] };
  }

  const tail = options.companyTail ?? DEFAULT_COMPANY_TAIL;
  const confidence: Partial<Record<keyof NormalizedRecord, Confidence>> = {
    companyName: tail.test(company) ? 'high' : 'medium',
    jobTitle: jobTitle ? 'high' : 'low',
    status: 'low',
    lastContactAt: 'low',
  };
  return {
    records: [
      {
        companyName: company,
        jobTitle,
        city,
        status: undefined,
        platformStatusText: undefined,
        lastContactAt: undefined,
        salaryText,
        rawSnippet: snippet,
        confidence,
        overall: overallOf(confidence),
      },
    ],
    unparsed: [],
  };
}
