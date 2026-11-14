/**
 * 模块三 · 快记词典与时间短语解析（表驱动、纯本地规则、一次网络请求都不发）。
 *
 * 性能纪律（R-06）：一句话解析要 < 5ms，所以
 * - 词典一律 `String.prototype.includes`，不写「今天与明天之间夹任意字符」那种回溯正则；
 * - 时间解析用**前缀锚定 + 固定字符类**，日期最后用 `new Date(y, m-1, d, H, M)` 本地构造，
 *   **禁止字符串拼 ISO**（那是时区错的第一来源）。
 */

import type { InterviewFormat, InterviewKind, Status } from '../../types';
import { addDays, daysBetween, startOfDay, startOfWeek, toDateISO } from '../date';

/** 词典版本（CAP-14 的调试日志要显示它） */
export const CAPTURE_DICT_VERSION = 1;

/** 意图（本模块专用；不叫 QuickNote 是为了不与面经快记撞名） */
export type CaptureIntent = 'interview' | 'chat' | 'followup' | 'memo';

/**
 * 意图词典。**顺序即优先级**：
 * 「催 / 跟进」是明确的动作，不能被句子里的「面试」两个字抢走；
 * 「回消息 / 沟通」次之；真正的面试排第三（它靠轮次词与「面试」二字命中）。
 */
export const INTENT_RULES: ReadonlyArray<{ intent: CaptureIntent; words: readonly string[] }> = [
  { intent: 'followup', words: ['催', '问了进度', '跟进', '问了一下', '催问'] },
  { intent: 'chat', words: ['回消息', '回复', '发了', '沟通', '聊了', '打招呼', '微信', '电话'] },
  { intent: 'interview', words: ['面试', '笔试', '约面', '一面', '二面', '三面', '四面', '五面', 'HR面'] },
  { intent: 'memo', words: ['记一下', '记一条', '记一笔', '备忘'] },
];

/** 状态建议词典（CAP-8：状态 chip 默认**未勾选**，勾了才写） */
export const STATUS_WORDS: ReadonlyArray<{ status: Status; words: readonly string[] }> = [
  { status: 'rejected', words: ['挂了', '拒了', '感谢信', '没过', '被拒'] },
  { status: 'offer', words: ['offer', 'Offer', '录用', '发了offer', '口头offer'] },
  { status: 'written', words: ['笔试'] },
];

/** 轮次词典：一面 → 1 … 十面 → 10 */
export const ROUND_WORDS: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

/** 面试形式词典（CAP-12：解析不出就是 null，**绝不默认 video**） */
export const FORMAT_WORDS: ReadonlyArray<{ format: InterviewFormat; words: readonly string[] }> = [
  { format: 'video', words: ['视频', '线上', '腾讯会议', 'zoom', '飞书会议'] },
  { format: 'phone', words: ['电话', '电面', '打电话'] },
  { format: 'onsite', words: ['现场', '线下', '到公司', '到面'] },
];

/** 面试轮次类型词典（InterviewKind） */
export const KIND_WORDS: ReadonlyArray<{ kind: InterviewKind; words: readonly string[] }> = [
  { kind: 'written', words: ['笔试'] },
  { kind: 'hr', words: ['HR面', 'hr面', 'HR 面'] },
  { kind: 'cross', words: ['交叉面'] },
  { kind: 'group', words: ['群面'] },
  { kind: 'director', words: ['总监面', '老板面'] },
  { kind: 'tech', words: ['技术面'] },
];

/** 模糊时间词（CAP-13：不解析，chip 标黄要求手选） */
export const VAGUE_TIME_WORDS: readonly string[] = [
  '过两天',
  '过几天',
  '下周左右',
  '月底前',
  '月初',
  '下个月',
  '这周某天',
  '找个时间',
];

/** 单句切分的分隔符：逗号 / 句号 / 分号 / 换行（CAP-10：一次只记一件） */
const SENTENCE_BREAKS = ['，', ',', '。', '；', ';', '\n'];

/**
 * CAP-10：只取第一个逗号/句号/分号前的内容；`tail` 非空时 UI 必须提示「一次记一件」。
 * 用 `indexOf` 逐个找最小下标，不用正则（R-06）。
 */
export function splitFirstSentence(text: string): { head: string; tail: string | null } {
  const source = (text ?? '').trim();
  let cut = -1;
  for (const mark of SENTENCE_BREAKS) {
    const index = source.indexOf(mark);
    if (index >= 0 && (cut < 0 || index < cut)) cut = index;
  }
  if (cut < 0) return { head: source, tail: null };
  const head = source.slice(0, cut).trim();
  const rest = source.slice(cut + 1).trim();
  return { head, tail: rest ? rest : null };
}

export interface ParsedTime {
  /**
   * 完整日期时间（ISO）→ 可建事件；
   * null + partial 非空 → 只有日期或只有时刻，**不许建 Interview**（CAP-3）；
   * null + vague=true → 时间不确定，chip 标黄要求手选（CAP-13）
   */
  iso: string | null;
  partial: 'dateOnly' | 'timeOnly' | null;
  vague: boolean;
  /** 解析出的日期早于今天（CAP-4：不自动加一年，UI 弹二选） */
  pastDate: boolean;
  /** 命中到的原文片段（chip 展示与调试用） */
  matched: string;
}

const WEEKDAY_OF_CHAR: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
};

/** 时段词 → 小时修正。'下午3点' → 15 点 */
const PERIODS: ReadonlyArray<{ words: readonly string[]; afterNoon: boolean; noon: boolean }> = [
  { words: ['凌晨'], afterNoon: false, noon: false },
  { words: ['早上', '早晨'], afterNoon: false, noon: false },
  { words: ['上午'], afterNoon: false, noon: false },
  { words: ['中午'], afterNoon: false, noon: true },
  { words: ['下午'], afterNoon: true, noon: false },
  { words: ['傍晚'], afterNoon: true, noon: false },
  { words: ['晚上'], afterNoon: true, noon: false },
];

const DAY_WORDS: ReadonlyArray<{ word: string; shift: number }> = [
  { word: '大后天', shift: 3 },
  { word: '后天', shift: 2 },
  { word: '明天', shift: 1 },
  { word: '明日', shift: 1 },
  { word: '今天', shift: 0 },
  { word: '今日', shift: 0 },
];

/**
 * 时间类噪声词（只给 `guessNewCompanyName` 用）。
 *
 * 为什么不直接用 `ParsedTime.matched` 去切原文：它是「日期片段 + 空格 + 时刻片段」拼出来的，
 * 而原文里这两块往往不连续（「明天下午3点」中间还夹着时段词），拿它 `split` 会切不干净，
 * 「新建公司」按钮上就会冒出「明天午3点小鹅」这种候选名。
 * 所以这里把**词**拆开列一遍，数字部分由调用方用有界正则剥掉。
 */
export const TIME_NOISE_WORDS: readonly string[] = [
  ...DAY_WORDS.map((item) => item.word),
  '下周',
  '下星期',
  '下礼拜',
  '周',
  '星期',
  '礼拜',
  ...PERIODS.flatMap((item) => item.words),
  // 模糊时间词也要剥：「过两天下周左右」不该在候选公司名里留下「过两天」
  ...VAGUE_TIME_WORDS,
];

interface DatePart {
  date: Date;
  matched: string;
}

/** 解析「哪一天」：日词优先，其次周几，其次 月日 / M-D / D号 */
function parseDatePart(text: string, now: Date): DatePart | null {
  for (const { word, shift } of DAY_WORDS) {
    if (text.includes(word)) {
      return { date: addDays(startOfDay(now), shift), matched: word };
    }
  }

  // 下周X / 下星期X / 周X / 星期X / 礼拜X
  for (const prefix of ['下周', '下星期', '下礼拜']) {
    const index = text.indexOf(prefix);
    if (index >= 0) {
      const char = text.charAt(index + prefix.length);
      const weekday = WEEKDAY_OF_CHAR[char];
      if (weekday) {
        const weekStart = addDays(startOfWeek(now), 7);
        return { date: addDays(weekStart, weekday - 1), matched: `${prefix}${char}` };
      }
    }
  }
  for (const prefix of ['周', '星期', '礼拜']) {
    const index = text.indexOf(prefix);
    if (index >= 0) {
      const char = text.charAt(index + prefix.length);
      const weekday = WEEKDAY_OF_CHAR[char];
      if (weekday) {
        const weekStart = startOfWeek(now);
        return { date: addDays(weekStart, weekday - 1), matched: `${prefix}${char}` };
      }
    }
  }

  // M月D日 / M月D号
  const monthIndex = text.indexOf('月');
  if (monthIndex > 0) {
    const month = Number(text.slice(Math.max(0, monthIndex - 2), monthIndex).replace(/[^\d]/g, ''));
    const dayMatch = /^(\d{1,2})[日号]/.exec(text.slice(monthIndex + 1));
    if (Number.isInteger(month) && month >= 1 && month <= 12 && dayMatch) {
      const day = Number(dayMatch[1]);
      if (day >= 1 && day <= 31) {
        return { date: new Date(now.getFullYear(), month - 1, day), matched: `${month}月${day}${dayMatch[0].slice(-1)}` };
      }
    }
  }

  // M/D
  const slash = /(\d{1,2})\/(\d{1,2})/.exec(text);
  if (slash) {
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { date: new Date(now.getFullYear(), month - 1, day), matched: slash[0] };
    }
  }

  // D号 / D日
  const dayOnly = /(\d{1,2})[号日]/.exec(text);
  if (dayOnly) {
    const day = Number(dayOnly[1]);
    if (day >= 1 && day <= 31) {
      return { date: new Date(now.getFullYear(), now.getMonth(), day), matched: dayOnly[0] };
    }
  }
  return null;
}

interface TimePart {
  hour: number;
  minute: number;
  matched: string;
}

/** 解析「几点」：HH:mm 优先，其次 H点[半|H分] */
function parseTimePart(text: string): TimePart | null {
  let hour: number | null = null;
  let minute = 0;
  let matched = '';

  const colon = /(\d{1,2}):(\d{2})/.exec(text);
  if (colon) {
    hour = Number(colon[1]);
    minute = Number(colon[2]);
    matched = colon[0];
  } else {
    const dot = /(\d{1,2})\s*点\s*(半|(\d{1,2})\s*分)?/.exec(text);
    if (dot) {
      hour = Number(dot[1]);
      minute = dot[2] === '半' ? 30 : dot[3] ? Number(dot[3]) : 0;
      matched = dot[0].trim();
    }
  }
  if (hour === null || !Number.isInteger(hour) || hour > 24) return null;
  if (!Number.isInteger(minute) || minute > 59) return null;

  // 时段修正：「下午 3 点」= 15 点。这句话不能反过来说「3 点就是下午」——不猜。
  let period: (typeof PERIODS)[number] | null = null;
  for (const candidate of PERIODS) {
    if (candidate.words.some((word) => text.includes(word))) {
      period = candidate;
      break;
    }
  }
  if (period) {
    if (period.noon) {
      if (hour < 12) hour += 12;
    } else if (period.afterNoon) {
      if (hour < 12) hour += 12;
    } else if (hour === 12) {
      // 「凌晨 12 点」是 0 点
      hour = 0;
    }
  }
  if (hour > 23) hour = 23;
  return { hour, minute, matched };
}

/**
 * 解析时间短语。返回 null = 句子里没有任何时间线索。
 *
 * 校验向量（PRD CAP-2）：
 *   今天 / 明天 / 后天 / 大后天 / 周三 / 下周三 / 3月14日 / 3/14 / 14号 /
 *   上午 / 中午 / 下午 / 晚上 / 凌晨 / 14:30 / 3点 / 3点半
 */
export function parseTimePhrase(text: string, now: Date): ParsedTime | null {
  const source = (text ?? '').trim();
  if (!source) return null;

  const vague = VAGUE_TIME_WORDS.some((word) => source.includes(word));
  const datePart = parseDatePart(source, now);
  const timePart = parseTimePart(source);

  if (vague) {
    return {
      iso: null,
      partial: null,
      vague: true,
      pastDate: false,
      matched: VAGUE_TIME_WORDS.find((word) => source.includes(word)) ?? '',
    };
  }
  if (!datePart && !timePart) return null;

  const matched = [datePart?.matched, timePart?.matched].filter(Boolean).join(' ');
  if (datePart && timePart) {
    // ★ 本地构造：绝不用字符串拼 ISO（时区错的高发点）
    const date = new Date(
      datePart.date.getFullYear(),
      datePart.date.getMonth(),
      datePart.date.getDate(),
      timePart.hour,
      timePart.minute,
      0,
      0,
    );
    return {
      iso: date.toISOString(),
      partial: null,
      vague: false,
      pastDate: daysBetween(now, date) < 0,
      matched,
    };
  }
  if (datePart) {
    return {
      iso: null,
      partial: 'dateOnly',
      vague: false,
      pastDate: daysBetween(now, datePart.date) < 0,
      matched,
    };
  }
  return { iso: null, partial: 'timeOnly', vague: false, pastDate: false, matched };
}

/** 供 UI 调试（CAP-14）：把 ISO 回显成 YYYY-MM-DD HH:mm 的本地串 */
export function captureTimeLabel(iso: string | null): string {
  if (!iso) return '未定';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '未定';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${toDateISO(date)} ${hh}:${mm}`;
}
