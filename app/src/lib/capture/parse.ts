/**
 * 模块三 · 一句话快记的解析与写库计划（纯函数，零 React / 零 IO；**纯本地规则，不调 AI**）。
 *
 * 这个模块唯一的价值观：**猜不准就问，绝不猜完直接落库**。
 * 每条「不猜」的落点：
 * - 公司三态（唯一 / 多候选 / 无候选）—— 不默认取第一条（CAP-5）；
 * - 岗位：该公司 ≥2 条投递时一律留空（CAP-5 / D-12）；
 * - 时间只有日期或只有时刻 → 不建 Interview（CAP-3）；
 * - `format` 解析不出就是 null，绝不默认 video（CAP-12）；
 * - 状态建议默认不勾（CAP-8）；
 * - 没听懂就老实说没听懂，原文不动（CAP-9）。
 */

import type {
  Application,
  Company,
  Interview,
  InterviewFormat,
  InterviewKind,
  NoteType,
  Status,
} from '../../types';
import type { NewInterviewInput } from '../api';
import {
  FORMAT_WORDS,
  INTENT_RULES,
  KIND_WORDS,
  ROUND_WORDS,
  STATUS_WORDS,
  TIME_NOISE_WORDS,
  captureTimeLabel,
  parseTimePhrase,
  splitFirstSentence,
  type CaptureIntent,
} from './dict';

export type { CaptureIntent };
export { captureTimeLabel };

export type CapturePick<T> =
  | { state: 'none' }
  | { state: 'unique'; item: T }
  | { state: 'ambiguous'; items: T[] };

export interface CaptureDraft {
  ok: true;
  /** 被采用的前半句原文 */
  raw: string;
  /** 被丢掉的后半句（CAP-10；非空时 UI 必须提示） */
  droppedTail: string | null;
  intent: CaptureIntent;
  company: CapturePick<Company>;
  /** ≥2 条投递时一律 state:'none'（D-12，不猜岗位） */
  application: CapturePick<Application>;
  scheduledAt: string | null;
  timePartial: 'dateOnly' | 'timeOnly' | null;
  timeVague: boolean;
  pastDate: boolean;
  round: number | null;
  kind: InterviewKind | null;
  /** ★ 解析不出就是 null，**绝不默认 'video'**（CAP-12） */
  format: InterviewFormat | null;
  /** ★ 状态建议默认未勾选（CAP-8），勾了才写 */
  statusSuggestion: Status | null;
  noteType: NoteType | null;
  /** 没命中任何时间词但句子里有「面」→ 提示「补个时间就能进日历」 */
  needsTimeHint: boolean;
}

export type CaptureResult =
  | CaptureDraft
  | { ok: false; reason: 'no_intent'; raw: string; hint: string }
  | { ok: false; reason: 'no_company'; raw: string; hint: string };

export interface CaptureContext {
  now: Date;
  companies: Company[];
  /** 未删除的投递 */
  applications: Application[];
  interviews: Interview[];
}

/** 用户点「保存」时把确认条的值交回来（每个 chip 都可改，改完仍走这里） */
export interface ConfirmedCapture {
  raw: string;
  intent: CaptureIntent;
  /** null = 需要新建公司（CAP-5「新建公司『小鹅』」按钮的产物，由 QuickAdd 用既有 addApplication 建） */
  applicationId: string | null;
  newCompanyName: string | null;
  newJobTitle: string | null;
  scheduledAt: string | null;
  round: number | null;
  kind: InterviewKind | null;
  format: InterviewFormat | null;
  noteType: NoteType | null;
  statusSuggestion: Status | null;
  statusConfirmed: boolean;
}

export type CaptureStep =
  | { kind: 'createApplication'; companyName: string; jobTitle: string; status: Status }
  | { kind: 'addNote'; applicationId: string; type: NoteType; content: string }
  | { kind: 'changeStatus'; applicationId: string; status: Status; round?: number }
  | { kind: 'addInterview'; input: NewInterviewInput };

/** 意图文案（确认条 chip 与 note 前缀共用，别在组件里再写一份） */
export const INTENT_LABEL: Record<CaptureIntent, string> = {
  interview: '面试',
  chat: '沟通',
  followup: '催问',
  memo: '随手记',
};

const NOTE_TYPE_OF_INTENT: Record<CaptureIntent, NoteType> = {
  interview: 'interview',
  chat: 'chat',
  followup: 'followup',
  memo: 'memo',
};

/** 命中词典里第一个词的意图；一个都没命中返回 null */
function intentOf(head: string): CaptureIntent | null {
  for (const rule of INTENT_RULES) {
    if (rule.words.some((word) => head.includes(word))) return rule.intent;
  }
  return null;
}

function statusOf(head: string): Status | null {
  for (const rule of STATUS_WORDS) {
    if (rule.words.some((word) => head.includes(word))) return rule.status;
  }
  return null;
}

function formatOf(head: string): InterviewFormat | null {
  for (const rule of FORMAT_WORDS) {
    if (rule.words.some((word) => head.includes(word))) return rule.format;
  }
  return null;
}

function kindOf(head: string): InterviewKind | null {
  for (const rule of KIND_WORDS) {
    if (rule.words.some((word) => head.includes(word))) return rule.kind;
  }
  return null;
}

/** 轮次：命中「二面」→ 2；「笔试」→ 0（与 Interview.round=0 的既有约定一致） */
function roundOf(head: string): number | null {
  if (head.includes('笔试')) return 0;
  for (const key of Object.keys(ROUND_WORDS)) {
    if (head.includes(`${key}面`)) return ROUND_WORDS[key];
  }
  return null;
}

/**
 * 公司匹配三态（CAP-5）：`name` / `shortName` 子串命中，**最长优先**。
 * 最长命中唯一 → unique；两条公司的最长命中一样长 → ambiguous（不替用户选）。
 */
export function matchCompany(head: string, companies: Company[]): CapturePick<Company> {
  const hits: Array<{ company: Company; length: number }> = [];
  for (const company of companies) {
    let length = 0;
    for (const name of [company.name, company.shortName]) {
      const text = (name ?? '').trim();
      if (text && head.includes(text) && text.length > length) length = text.length;
    }
    if (length > 0) hits.push({ company, length });
  }
  if (hits.length === 0) return { state: 'none' };
  const longest = Math.max(...hits.map((hit) => hit.length));
  const top = hits.filter((hit) => hit.length === longest);
  if (top.length === 1) return { state: 'unique', item: top[0].company };
  return { state: 'ambiguous', items: top.map((hit) => hit.company) };
}

/**
 * 岗位匹配（CAP-5 / D-12）：
 * - 公司唯一命中且**只有 1 条投递** → 自动带入；
 * - **≥2 条 → 一律留空**（不许默认取第一条）；
 * - 0 条 → 留空（用户可新建）。
 */
export function matchApplication(
  company: CapturePick<Company>,
  applications: Application[],
): CapturePick<Application> {
  if (company.state !== 'unique') return { state: 'none' };
  const own = applications.filter((app) => app.companyId === company.item.id && !app.deletedAt);
  if (own.length === 1) return { state: 'unique', item: own[0] };
  return { state: 'none' };
}

/**
 * 从原文里把「公司名」猜出来（只用于「新建公司『小鹅』」按钮的候选值，不写库）。
 *
 * 剥两轮：
 * 1. 时间——先按词剥（明天 / 下午 / 下周…），再用**有界**数字正则剥「3点 / 3点半 / 14:30 / 14号 / 3/14」。
 *    不用 `ParsedTime.matched` 去 split：那是「日期 空格 时刻」拼的，在原文里不连续（见 dict 注释）。
 * 2. 意图 / 状态 / 轮次 / 形式词，以及一堆虚词。
 */
export function guessNewCompanyName(head: string): string {
  // 「下周三」必须整块剥：先剥「下周」会在候选名里留下一个孤零零的「三」
  let rest = head.replace(/(下)?(周|星期|礼拜)[一二三四五六日天]/g, ' ');
  for (const word of TIME_NOISE_WORDS) rest = rest.split(word).join(' ');
  rest = rest
    .replace(/\d{1,2}:\d{2}/g, ' ')
    .replace(/\d{1,2}\s*点\s*(\d{1,2}\s*分|半)?/g, ' ')
    .replace(/\d{1,2}\s*\/\s*\d{1,2}/g, ' ')
    .replace(/\d{1,2}\s*[号日]/g, ' ')
    .replace(/\d{1,2}\s*月/g, ' ');

  const noise: string[] = [];
  for (const rule of INTENT_RULES) noise.push(...rule.words);
  for (const rule of STATUS_WORDS) noise.push(...rule.words);
  for (const key of Object.keys(ROUND_WORDS)) noise.push(`${key}面`);
  for (const rule of FORMAT_WORDS) noise.push(...rule.words);
  noise.push('面试', '笔试', 'HR', 'hr', '的', '了', '给', '帮', '问', '约', '下', '和', '跟', '再', '又', '还', '记', '一下');
  for (const word of noise) rest = rest.split(word).join(' ');
  const cleaned = rest
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join('');
  return cleaned.slice(0, 10);
}

/**
 * 解析一句话。
 *
 * 失败态只有两种，都**不产生建议、不写库**：
 * - `no_intent`：一个意图词都没命中（CAP-9，原文留在输入框）；
 * - `no_company`：命中了意图但整句里没有任何「像公司名」的残余（CAP-5「哪家公司？」）。
 *   有残余时返回正常 draft（`company.state = 'none'`），让 UI 给「新建公司『X』」按钮。
 */
export function parseQuickNote(text: string, ctx: CaptureContext): CaptureResult {
  const { head, tail } = splitFirstSentence(text);
  if (!head) {
    return { ok: false, reason: 'no_intent', raw: (text ?? '').trim(), hint: '没听出来要记什么' };
  }

  const statusSuggestion = statusOf(head);
  const intent = intentOf(head) ?? (statusSuggestion ? 'memo' : null);
  if (!intent) {
    return {
      ok: false,
      reason: 'no_intent',
      raw: head,
      hint: '没听出来要记什么，可以试「明天下午 3 点字节二面」',
    };
  }

  const company = matchCompany(head, ctx.companies);
  const application = matchApplication(company, ctx.applications);
  const time = parseTimePhrase(head, ctx.now);

  if (company.state === 'none') {
    const guess = guessNewCompanyName(head);
    if (!guess) {
      return { ok: false, reason: 'no_company', raw: head, hint: '哪家公司？' };
    }
  }

  const round = roundOf(head);
  const needsTimeHint = !time && head.includes('面');

  return {
    ok: true,
    raw: head,
    droppedTail: tail,
    intent,
    company,
    application,
    scheduledAt: time?.iso ?? null,
    timePartial: time?.partial ?? null,
    timeVague: time?.vague ?? false,
    pastDate: time?.pastDate ?? false,
    round,
    kind: kindOf(head),
    format: formatOf(head),
    statusSuggestion,
    noteType: NOTE_TYPE_OF_INTENT[intent],
    needsTimeHint,
  };
}

/** note 正文：原文就是最好的记录（截 200 字，与 OfferDetail.notes 同口径） */
function noteContentOf(draft: ConfirmedCapture): string {
  const raw = (draft.raw ?? '').trim().slice(0, 200);
  if (!raw) return INTENT_LABEL[draft.intent];
  return raw;
}

/**
 * 把确认条收敛成**有序**写库步骤（纯函数，便于断言「CAP-3 不产生 addInterview」这类规则）。
 *
 * 顺序固定：建公司/投递 → 改状态 → 写 note → 建面试
 * （状态变更的 system note 会由 changeStatus 自己写，不必再补）。
 *
 * ★ 意图是面试且能建面试时**只建面试、不再写 note** —— 否则「记一场面试」会变成两笔记录。
 */
/**
 * CAP-4：时间落在过去 → 必须由用户二选（「是，明年」/「否，我重选」）。
 *
 * 为什么不在这里自动加一年：加一年是一个**猜测**。11 月说「1月5日」可能是明年 1 月，
 * 也可能是在补记今年年初的一场面试（用户就是想把历史记进来）。
 * 两个意图都不离谱，所以只能问，不能猜。
 *
 * ★ 这个判断放在纯函数层而不是只管住 UI：`planCaptureCommit` 也调它，
 *   于是即使将来有人在别处调用写库，也不可能把面试记到过去。
 *
 * @param draft 待提交的确认结果
 * @param now 当前时间（测试可注入）
 */
export function isPastDateBlocked(draft: ConfirmedCapture, now: Date): boolean {
  if (!draft.scheduledAt) return false;
  const at = new Date(draft.scheduledAt).getTime();
  if (Number.isNaN(at)) return false;
  // 恰好「现在」不算过去 —— 边界上放宽，别让用户刚说完就保存不了
  return at < now.getTime();
}

/**
 * CAP-4 的「是，明年」：把时间推后一年，**保持本地墙上时间不变**。
 *
 * 闰日要特殊处理：2024-02-29 + 1 年不存在，`setFullYear` 会溢出到 3/1，
 * 这里退回到该年 2 月最后一天。宁可差一天，也不制造一个不存在的日期。
 */
export function shiftToNextYear(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const next = new Date(at);
  next.setFullYear(at.getFullYear() + 1);
  if (next.getMonth() !== at.getMonth()) next.setDate(0);
  return next.toISOString();
}

export function planCaptureCommit(draft: ConfirmedCapture, ctx: CaptureContext): CaptureStep[] {
  // CAP-4：时间在过去且用户还没二选 → 一步都不写（绝不把面试记到过去）
  if (isPastDateBlocked(draft, ctx.now)) return [];

  const steps: CaptureStep[] = [];
  const applicationId = draft.applicationId;

  if (!applicationId) {
    const companyName = (draft.newCompanyName ?? '').trim();
    const jobTitle = (draft.newJobTitle ?? '').trim();
    if (!companyName || !jobTitle) return steps;
    steps.push({
      kind: 'createApplication',
      companyName,
      jobTitle,
      status: draft.statusConfirmed && draft.statusSuggestion ? draft.statusSuggestion : 'applied',
    });
    // 新建后拿不到 id，本轮的其余步骤一律做不了 —— 宁可少写，也不要写进错的行
    return steps;
  }

  if (draft.statusConfirmed && draft.statusSuggestion) {
    steps.push({
      kind: 'changeStatus',
      applicationId,
      status: draft.statusSuggestion,
      ...(draft.round !== null ? { round: draft.round } : {}),
    });
  }

  const canCreateInterview =
    draft.intent === 'interview' && Boolean(draft.scheduledAt) && Boolean(draft.format);

  if (!canCreateInterview && draft.noteType) {
    steps.push({
      kind: 'addNote',
      applicationId,
      type: draft.noteType,
      content: noteContentOf(draft),
    });
  }

  if (canCreateInterview && draft.scheduledAt && draft.format) {
    steps.push({
      kind: 'addInterview',
      input: {
        applicationId,
        round: draft.round ?? 1,
        ...(draft.kind ? { kind: draft.kind } : {}),
        scheduledAt: draft.scheduledAt,
        format: draft.format,
        result: 'pending',
      },
    });
  }

  return steps;
}

/**
 * 确认条底部的「会写入 N 场面试 / 关联到 X」提示（UI 不拼字符串）。
 *
 * 顺序与 `planCaptureCommit` **保持一致**：撤销是倒着来的，两处顺序不一致
 * 会让人对不上「我按了几下 ⌘Z 才退回到这一步」。
 */
export function captureSummary(draft: ConfirmedCapture): string {
  if (!draft.applicationId) {
    return draft.newCompanyName
      ? `会新建「${draft.newCompanyName}」这条投递`
      : '还没有可以写入的目标';
  }
  const parts: string[] = [];
  if (draft.statusConfirmed && draft.statusSuggestion) parts.push('1 次状态变更');
  if (draft.intent === 'interview' && draft.scheduledAt && draft.format) parts.push('1 场面试');
  else parts.push('1 条记录');
  return `会写入 ${parts.join(' + ')}`;
}
