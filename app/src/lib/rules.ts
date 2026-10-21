/**
 * 核心规则与派生计算 —— 这一层是产品灵魂，视图只负责展示。
 *
 * 关键派生：
 * 1. lastActivityAt = max(statusChangedAt, 该投递下所有 note.touchedAt)
 * 2. silenceDays    = 今天(零点) − lastActivityAt 的自然日差
 * 3. 阈值按渠道系数放大（内推流程天然慢，别让学生白白焦虑）
 * 4. 沉默只在 applied / chatting / interviewing / offer 四个状态下派生，其余一律 null
 *    （v0.3 起加入 offer：「Offer 发了一周没回音」是最贵的沉默，之前的版本不报警）
 * 5. 截止（deadlineAt）是**另一条轴**，与沉默正交：沉默说「对方不理我」，
 *    截止说「外部世界给我的最后期限」。两者都要进今日必做，且互不替代。
 */

import type {
  AppSettings,
  Application,
  CalendarEvent,
  Channel,
  Company,
  DB,
  Interview,
  InterviewFormat,
  InterviewResult,
  Note,
  NoteType,
  Status,
} from '../types';
import {
  daysBetween,
  fmtDate,
  fmtTime,
  isSameDay,
  parseFlexible,
  startOfDay,
  startOfWeek,
  timeToMinutes,
  toDateISO,
  weekdayOf,
} from './date';

/* ---------------------------------------------------------------- 常量表 */

export const STATUS_LABEL: Record<Status, string> = {
  wishlist: '想投',
  applied: '已投递',
  chatting: '已沟通',
  scheduled: '已约面',
  interviewing: '面试中',
  offer: '已发 Offer',
  onboarded: '已入职',
  rejected: '已挂',
  dropped: '已放弃',
};

/** 状态色（用于列头细色条、卡片标签） */
export const STATUS_TONE: Record<Status, string> = {
  wishlist: '#9AA0B4',
  applied: '#4F5BD5',
  chatting: '#3B82F6',
  scheduled: '#7C5CD6',
  interviewing: '#F5A524',
  offer: '#1F9D55',
  onboarded: '#0E9F6E',
  rejected: '#E5484D',
  dropped: '#8A8FA3',
};

/** 看板上的 6 个进行中列（从左到右＝时间顺序） */
export const BOARD_COLUMNS: Status[] = [
  'wishlist',
  'applied',
  'chatting',
  'scheduled',
  'interviewing',
  'offer',
];

/** 终态：收进右侧折叠的「已结束」列 */
export const ENDED_STATUSES: Status[] = ['onboarded', 'rejected', 'dropped'];

/**
 * 参与沉默计算的状态。
 * v0.3 加入 'offer'：拿到 Offer 之后「等审批 / 等 HR 回信 / 等自己决定」同样会拖，
 * 而且这一环的机会成本最高（拖黄了就是真没了）。之前不覆盖它，是最大的漏报。
 */
export const SILENCE_STATUSES: Status[] = ['applied', 'chatting', 'interviewing', 'offer'];

export const ALL_STATUSES: Status[] = [...BOARD_COLUMNS, ...ENDED_STATUSES];

export const CHANNEL_LABEL: Record<Channel, string> = {
  boss: 'BOSS直聘',
  shixiseng: '实习僧',
  nowcoder: '牛客',
  referral: '内推',
  official: '官网',
  other: '其他',
};

export const CHANNEL_OPTIONS: Channel[] = [
  'boss',
  'shixiseng',
  'nowcoder',
  'referral',
  'official',
  'other',
];

export const JOB_TYPE_LABEL: Record<'daily' | 'summer' | 'fulltime', string> = {
  daily: '日常实习',
  summer: '暑期实习',
  fulltime: '校招',
};

export const NOTE_TYPE_LABEL: Record<NoteType, string> = {
  chat: '沟通',
  interview: '面试',
  followup: '催问',
  system: '系统',
  memo: '随手记',
  // v2：同步写的时间线单独一种，UI 用灰 chip + 半透明，和「我记的」一眼可分
  sync: '同步',
};

export const FORMAT_LABEL: Record<InterviewFormat, string> = {
  onsite: '现场',
  video: '视频',
  phone: '电话',
};

export const RESULT_LABEL: Record<InterviewResult, string> = {
  pending: '待记结果',
  passed: '已通过',
  failed: '未通过',
  cancelled: '已取消',
};

/* ------------------------------------------------------------ 基础查询 */

/** 某条投递下的全部时间线，按时间倒序（最新在前） */
export function notesOf(notes: Note[], applicationId: string): Note[] {
  return notes
    .filter((n) => n.applicationId === applicationId)
    .sort((a, b) => (a.touchedAt < b.touchedAt ? 1 : a.touchedAt > b.touchedAt ? -1 : 0));
}

/** 某条投递下的全部面试，按时间正序 */
export function interviewsOf(interviews: Interview[], applicationId: string): Interview[] {
  return interviews
    .filter((i) => i.applicationId === applicationId)
    .sort((a, b) => parseFlexible(a.scheduledAt).getTime() - parseFlexible(b.scheduledAt).getTime());
}

/** 全库最近 N 条动态（跨公司） */
export function recentNotes(notes: Note[], limit = 10): Note[] {
  return [...notes]
    .sort((a, b) => (a.touchedAt < b.touchedAt ? 1 : a.touchedAt > b.touchedAt ? -1 : 0))
    .slice(0, limit);
}

/**
 * 时间线的「按投递分桶」索引。
 *
 * 为什么需要它：`lastActivityAtOf` 每次调用都要扫全表 notes 并按 applicationId 过滤，
 * 而它的调用者是「每条投递一次」。合起来是 O(投递数 × 时间线条数) ——
 * 300 条投递 + 3000 条时间线 = 每次渲染 90 万次比较，而且 TodayView 每分钟都会重算一遍。
 * 建一次索引就变成 O(投递数 + 时间线条数)，这是本项目唯一一处真正的算法级性能问题。
 */
export type NoteIndex = Map<string, Note[]>;

/** 按 applicationId 分桶，桶内按时间倒序（与 notesOf 输出一致） */
export function buildNoteIndex(notes: Note[]): NoteIndex {
  const index: NoteIndex = new Map();
  for (const note of notes) {
    const bucket = index.get(note.applicationId);
    if (bucket) bucket.push(note);
    else index.set(note.applicationId, [note]);
  }
  for (const bucket of index.values()) {
    bucket.sort((a, b) => (a.touchedAt < b.touchedAt ? 1 : a.touchedAt > b.touchedAt ? -1 : 0));
  }
  return index;
}

/**
 * 卡片上要展示的「最新一条人写的记录」（v0.5）。
 *
 * 为什么过滤 `auto`：示例数据和同步引擎都会写 `auto: true` 的流水
 * （「状态改为已投递」「BOSS 上变为已读」），这些是系统行为不是用户的话。
 * 卡片预览的目的只有一个 —— 不点开详情就能想起「我上次记了什么」，
 * 系统流水帮不上这个忙，反而会把用户真正写的那条挤掉。
 * 桶内已按时间倒序（buildNoteIndex 保证），所以 find 到的第一条就是最新的。
 *
 * 全是人写的都没有时返回 null（卡片就不显示预览行，与「0 条记录」一致）。
 */
export function latestUserNoteOf(index: NoteIndex, appId: string): Note | null {
  const bucket = index.get(appId);
  if (!bucket) return null;
  return bucket.find((note) => !note.auto) ?? null;
}

/**
 * 沉默基准时间：状态变更时间与所有 note 时间的最大值。
 * 只要新增任意一条 Note 或状态变更，基准立刻刷新 —— 红色标记自动消失。
 *
 * `index` 可选：批量调用（buildTodos）时传索引，单条查询不传也行。
 */
export function lastActivityAtOf(app: Application, notes: Note[], index?: NoteIndex): string {
  let latest = app.statusChangedAt || app.createdAt;
  let latestMs = parseFlexible(latest).getTime();
  if (!Number.isFinite(latestMs)) latestMs = 0;
  const bucket = index ? index.get(app.id) : notes.filter((note) => note.applicationId === app.id);
  if (!bucket) return latest;
  for (const note of bucket) {
    const ms = parseFlexible(note.touchedAt).getTime();
    if (Number.isFinite(ms) && ms > latestMs) {
      latestMs = ms;
      latest = note.touchedAt;
    }
  }
  return latest;
}

/** 沉默天数（自然日差，最小 0） */
export function silenceDaysOf(
  app: Application,
  notes: Note[],
  now: Date = new Date(),
  index?: NoteIndex,
): number {
  const last = lastActivityAtOf(app, notes, index);
  const diff = daysBetween(last, now);
  return diff > 0 ? diff : 0;
}

/** 渠道系数，缺省 1 */
export function channelFactorOf(app: Application, settings: AppSettings): number {
  const channel = app.channel;
  if (!channel) return 1;
  const factor = settings.channelFactor[channel];
  return typeof factor === 'number' && factor > 0 ? factor : 1;
}

/**
 * 该投递实际生效的「该跟进」阈值。
 * - 用户给这一家单独设过阈值（silenceOverride）→ 按绝对值算，不再乘渠道系数，
 *   否则「填 10 的内推要 30 天才红」没人能理解；warn 取 min(全局 warn, 阈值的一半)。
 * - offer 阶段 → 不乘渠道系数（见 effectiveStaleDays 的说明），取 offerSilenceDays 的一半。
 * - 否则 → 全局阈值 × 渠道系数（内推 ×3 / 官网 ×2 / 其余 ×1），向上取整。
 */
export function effectiveWarnDays(app: Application, settings: AppSettings): number {
  const warnBase = Math.max(1, settings.warnAfterDays);
  if (app.silenceOverride !== null && app.silenceOverride !== undefined) {
    return Math.max(1, Math.min(warnBase, Math.ceil(app.silenceOverride * 0.5)));
  }
  if (app.status === 'offer') {
    return Math.max(1, Math.ceil(Math.max(1, settings.offerSilenceDays) * 0.5));
  }
  return Math.ceil(warnBase * channelFactorOf(app, settings));
}

/**
 * 该投递实际生效的「已沉默」阈值（override 为绝对值；否则按状态取基准再乘系数）。
 *
 * ★ offer 为什么**不乘渠道系数**：
 *   Offer 的等待是「公司内部审批 + 自己权衡」，与投递渠道无关。
 *   内推 ×3 会把默认的 7 天变成 21 天 —— 等于永不提醒，
 *   而 Offer 恰恰是最不能拖的一环。渠道系数表达的是「流程长」，不是「拖着不亏」。
 */
export function effectiveStaleDays(app: Application, settings: AppSettings): number {
  if (app.silenceOverride !== null && app.silenceOverride !== undefined) {
    return Math.max(1, app.silenceOverride);
  }
  if (app.status === 'offer') {
    return Math.max(1, settings.offerSilenceDays);
  }
  const base = app.status === 'interviewing' ? settings.interviewResultWaitDays : settings.staleAfterDays;
  return Math.ceil(Math.max(1, base) * channelFactorOf(app, settings));
}

export type SilenceLevel = 'stale' | 'warn' | null;

/** 沉默文案的「动词」——同一个天数在不同阶段的含义完全不同，不能都用「已沉默」 */
function silenceVerbOf(status: Status): string {
  if (status === 'interviewing') return '等结果';
  if (status === 'offer') return '等 Offer 回复';
  return '已沉默';
}

export interface SilenceState {
  /** 沉默天数；不参与计算的状态返回 0 */
  days: number;
  level: SilenceLevel;
  /** 展示文案 */
  text: string;
}

/**
 * 沉默派生状态。
 * 只有 applied / chatting / interviewing / offer 参与；
 * interviewing 用「等结果天数」、offer 用「等 Offer 天数」当阈值。
 */
export function silenceStateOf(
  app: Application,
  notes: Note[],
  settings: AppSettings,
  now: Date = new Date(),
  index?: NoteIndex,
): SilenceState {
  if (!SILENCE_STATUSES.includes(app.status)) {
    return { days: 0, level: null, text: '' };
  }
  const days = silenceDaysOf(app, notes, now, index);
  const warnAt = effectiveWarnDays(app, settings);
  const staleAt = effectiveStaleDays(app, settings);
  if (days >= staleAt) {
    return { days, level: 'stale', text: `${silenceVerbOf(app.status)} ${days} 天` };
  }
  if (days >= warnAt) {
    return { days, level: 'warn', text: `该跟进了 · ${days} 天` };
  }
  return { days, level: null, text: `最近有互动 · ${days} 天` };
}

/** 想投超期：返回已放置天数（>= 阈值），否则 null */
export function wishlistExpiredDays(
  app: Application,
  settings: AppSettings,
  now: Date = new Date(),
): number | null {
  if (app.status !== 'wishlist') return null;
  const days = daysBetween(app.createdAt, now);
  if (days >= Math.max(1, settings.wishlistExpireDays)) return days;
  return null;
}

/* -------------------------------------------------------------- 截止 / 静音 */

/**
 * 截止状态分级。
 * - `overdue`：已经过了截止日（外部世界已经不等人了）
 * - `today`  ：就是今天
 * - `soon`   ：在 settings.deadlineWarnDays 之内
 * - null     ：不提醒（还没到预警窗口）
 */
export type DeadlineLevel = 'overdue' | 'today' | 'soon' | null;

export interface DeadlineState {
  /** 距今自然日差：今天 = 0，已过为负；无截止为 null */
  days: number | null;
  level: DeadlineLevel;
  text: string;
}

/** 终态不需要截止提醒：人已经入职/已挂/已放弃，再提醒只是噪音 */
function deadlineRelevant(app: Application): boolean {
  return !ENDED_STATUSES.includes(app.status);
}

/**
 * 截止派生。
 *
 * ★ 三态读法（与 types.ts 一致）：`undefined` 与 `null` **都不提醒**，
 *   差别只在于未来接入 Season 后 `undefined` 会去继承季节的截止日。
 *   在当前版本（还没有 Season 实体）两者行为一致，但语义必须保留 ——
 *   否则等 Season 上线时，所有历史数据会被读成「用户主动关闭了截止」。
 */
export function deadlineStateOf(
  app: Application,
  settings: AppSettings,
  now: Date = new Date(),
): DeadlineState {
  if (!deadlineRelevant(app)) return { days: null, level: null, text: '' };
  const raw = app.deadlineAt;
  if (raw === null || raw === undefined || raw === '') return { days: null, level: null, text: '' };
  const target = parseFlexible(raw);
  if (isNaN(target.getTime())) return { days: null, level: null, text: '' };

  const days = daysBetween(now, target);
  if (days < 0) {
    return { days, level: 'overdue', text: `已过截止 ${Math.abs(days)} 天` };
  }
  if (days === 0) {
    return { days, level: 'today', text: '今天截止' };
  }
  const warnAt = Math.max(1, settings.deadlineWarnDays);
  if (days <= warnAt) {
    return { days, level: 'soon', text: `还有 ${days} 天截止` };
  }
  return { days, level: null, text: `${days} 天后截止` };
}

/** 排序权重：越紧急越大（overdue 最高，因为它是既成事实的损失） */
export function deadlineUrgency(state: DeadlineState): number {
  if (state.level === 'overdue') return 400 + Math.abs(state.days ?? 0);
  if (state.level === 'today') return 300;
  if (state.level === 'soon') return 200 - (state.days ?? 0);
  return 0;
}

/**
 * 是否处于静音期。
 *
 * 语义边界（重要）：静音只压「我们觉得你该动了」的软提醒（沉默/想投超期），
 * **压不住硬截止**。理由：软提醒的依据是算法推断，用户比算法更清楚自己在等什么；
 * 而截止是外部世界的既成事实，压掉它等于帮用户隐藏真实风险。
 */
export function isMuted(app: Application, now: Date = new Date()): boolean {
  if (!app.mutedUntil) return false;
  const until = parseFlexible(app.mutedUntil).getTime();
  if (!Number.isFinite(until)) return false;
  return until > now.getTime();
}

/**
 * 静音还剩几天；未静音或已到期返回 null。
 * 用**自然日差**（与沉默天数同一口径），不用毫秒差 ——
 * 「到 25 号中午」在 20 号上午看应该显示「还剩 5 天」，而不是「6 天」。
 */
export function muteRemainDays(app: Application, now: Date = new Date()): number | null {
  if (!app.mutedUntil) return null;
  const until = parseFlexible(app.mutedUntil);
  if (isNaN(until.getTime())) return null;
  if (until.getTime() <= now.getTime()) return null;
  return Math.max(1, daysBetween(now, until));
}

/** 下（或上一场）面试：优先返回未记录结果的最近一场 */
export function nextInterviewOf(
  interviews: Interview[],
  applicationId: string,
  now: Date = new Date(),
): Interview | null {
  const list = interviewsOf(interviews, applicationId).filter((i) => i.result === 'pending');
  if (list.length === 0) return null;
  const future = list.find((i) => parseFlexible(i.scheduledAt).getTime() >= now.getTime());
  return future || list[list.length - 1];
}

/* -------------------------------------------------------------- 待办聚合 */

export interface TodoApp {
  app: Application;
  days: number;
  level: 'stale' | 'warn';
}

export interface TodoInterview {
  interview: Interview;
  app: Application;
  at: Date;
}

/** 截止类待办：只有落在预警窗口内（overdue / today / soon）才会进来 */
export interface TodoDeadline {
  app: Application;
  state: DeadlineState;
}

export interface Todos {
  stale: TodoApp[];
  warn: TodoApp[];
  todayInterview: TodoInterview[];
  needResult: TodoInterview[];
  wishlistExpired: TodoApp[];
  /** v0.3：截止（含已过期），按紧急度降序 */
  deadline: TodoDeadline[];
}

/**
 * 面试「进行中 / 已结束」的阶段文案（只对未记结果的面试有意义）。
 * 用于：卡片上替掉倒计时、今日待办里说明"为什么还没催你记结果"。
 */
export function interviewPhaseLabel(interview: Interview, now: Date, settings: AppSettings): string {
  if (interview.result !== 'pending') return '';
  const start = parseFlexible(interview.scheduledAt).getTime();
  if (!Number.isFinite(start)) return '';
  const end = start + durationOf(interview) * 60 * 1000;
  const nowMs = now.getTime();
  if (nowMs < start) return '';
  if (nowMs < end) return '面试进行中';
  const promptHour = settings.resultPromptHour ?? 20;
  if (isSameDay(now, interview.scheduledAt) && now.getHours() < promptHour) {
    return '已结束，稍后记结果';
  }
  return '已结束，待记结果';
}

/**
 * 待办聚合：
 * - 今日面试：scheduledAt 落在今天（含已开始但还没到提示时间的）
 * - 待记结果：scheduledAt 已过 且 result === 'pending'，且满足任一
 *     ① 面试日期早于今天（跨天了，必须记结果）
 *     ② 就是今天，且当前时间 >= settings.resultPromptHour（默认 20:00，PRD 口径）
 *   中间这段时间面试仍留在「今日面试」里，只是卡片上会显示「进行中 / 稍后记结果」。
 * - 其余按沉默派生规则（红/黄）+ 想投超期
 */
export function buildTodos(db: DB, now: Date = new Date()): Todos {
  const appIndex = new Map<string, Application>();
  for (const app of db.applications) appIndex.set(app.id, app);
  // 索引只建一次，循环里不再扫全表（见 buildNoteIndex 的说明）
  const noteIndex = buildNoteIndex(db.notes);

  const stale: TodoApp[] = [];
  const warn: TodoApp[] = [];
  const wishlistExpired: TodoApp[] = [];
  const deadline: TodoDeadline[] = [];

  for (const app of db.applications) {
    // 截止先算：它不受静音影响（静音压的是算法推断，不是外部事实）
    const due = deadlineStateOf(app, db.settings, now);
    if (due.level !== null) deadline.push({ app, state: due });

    // 静音期内的软提醒一律不进今日必做 —— 用户已经明确表示「这段时间别催我」
    if (isMuted(app, now)) continue;

    const state = silenceStateOf(app, db.notes, db.settings, now, noteIndex);
    if (state.level === 'stale') stale.push({ app, days: state.days, level: 'stale' });
    else if (state.level === 'warn') warn.push({ app, days: state.days, level: 'warn' });

    const expired = wishlistExpiredDays(app, db.settings, now);
    if (expired !== null) wishlistExpired.push({ app, days: expired, level: 'warn' });
  }

  const todayInterview: TodoInterview[] = [];
  const needResult: TodoInterview[] = [];
  const promptHour = db.settings.resultPromptHour ?? 20;

  for (const interview of db.interviews) {
    const app = appIndex.get(interview.applicationId);
    if (!app) continue;
    if (ENDED_STATUSES.includes(app.status)) continue;
    const at = parseFlexible(interview.scheduledAt);
    if (isNaN(at.getTime())) continue;
    const today = isSameDay(at, now);
    const passed = at.getTime() < now.getTime();
    const promptReached = !today || now.getHours() >= promptHour;
    if (interview.result === 'pending' && passed && promptReached) {
      needResult.push({ interview, app, at });
      continue;
    }
    if (today) {
      todayInterview.push({ interview, app, at });
    }
  }

  stale.sort((a, b) => b.days - a.days);
  warn.sort((a, b) => b.days - a.days);
  wishlistExpired.sort((a, b) => b.days - a.days);
  todayInterview.sort((a, b) => a.at.getTime() - b.at.getTime());
  needResult.sort((a, b) => a.at.getTime() - b.at.getTime());
  deadline.sort((a, b) => deadlineUrgency(b.state) - deadlineUrgency(a.state));

  return { stale, warn, todayInterview, needResult, wishlistExpired, deadline };
}

/**
 * 统一的「今天要做的 N 件事」，按 红 > 蓝 > 黄 排序。
 * 注意：调用方必须把 `settings` 传进来 —— 今日面试的「进行中 / 已结束」文案要读 `resultPromptHour`。
 */
export interface ActionItem {
  key: string;
  kind: 'deadline' | 'stale' | 'warn' | 'interview' | 'result' | 'wishlist';
  appId: string;
  interviewId?: string;
  title: string;
  detail: string;
  tone: 'red' | 'blue' | 'amber';
  /** 勾选表示「已处理」，系统会写一条 note 或打开详情 */
  doneHint: string;
}

/**
 * 统一的「今天要做的 N 件事」，顺序严格按 红 > 蓝 > 黄：
 *   红：截止已过/今天 + 沉默已深
 *   蓝：今天有面试 + 面试结果没记
 *   黄：快截止了 + 该轻催 + 想投放太久
 * 同一档内按紧急度降序。**顺序即优先级** —— 今日视图的行动预算直接切前 N 条，
 * 所以这里的排序就是「折叠时先藏谁」的唯一依据，改动前先想清楚。
 */
export function buildActionItems(
  todos: Todos,
  companies: Company[],
  settings: AppSettings,
  now: Date = new Date(),
): ActionItem[] {
  const nameOf = (companyId: string): string => {
    const found = companies.find((c) => c.id === companyId);
    return found ? found.shortName || found.name : '未知公司';
  };
  const items: ActionItem[] = [];

  const pushDeadline = (item: TodoDeadline, tone: 'red' | 'amber'): void => {
    items.push({
      key: `due_${item.app.id}`,
      kind: 'deadline',
      appId: item.app.id,
      title: `${nameOf(item.app.companyId)} · ${item.app.jobTitle}`,
      detail:
        item.app.status === 'offer'
          ? `Offer 回复${item.state.text}`
          : `截止 ${fmtDate(item.app.deadlineAt)} · ${item.state.text}`,
      tone,
      doneHint: item.state.level === 'overdue' ? '处理或放弃' : '去处理',
    });
  };

  // ① 红：截止最紧的一批 —— 外部世界的期限比算法推断更硬
  for (const item of todos.deadline) {
    if (item.state.level === 'overdue' || item.state.level === 'today') pushDeadline(item, 'red');
  }
  for (const item of todos.stale) {
    items.push({
      key: `stale_${item.app.id}`,
      kind: 'stale',
      appId: item.app.id,
      title: `${nameOf(item.app.companyId)} · ${item.app.jobTitle}`,
      detail:
        item.app.status === 'offer'
          ? `Offer 拿到 ${item.days} 天没回音，别让它凉了`
          : `${item.app.status === 'interviewing' ? '等结果' : '沉默'} ${item.days} 天，机会在流失`,
      tone: 'red',
      doneHint: '催一下',
    });
  }
  for (const item of todos.todayInterview) {
    const phase = interviewPhaseLabel(item.interview, now, settings);
    items.push({
      key: `today_${item.interview.id}`,
      kind: 'interview',
      appId: item.app.id,
      interviewId: item.interview.id,
      title: `${fmtTime(item.interview.scheduledAt)} ${nameOf(item.app.companyId)} · ${item.app.jobTitle}`,
      detail: `第 ${item.interview.round} 轮面试${item.interview.locationOrLink ? ` · ${item.interview.locationOrLink}` : ''}${
        phase ? ` · ${phase}` : ''
      }`,
      tone: 'blue',
      doneHint: '看准备清单',
    });
  }
  for (const item of todos.needResult) {
    items.push({
      key: `result_${item.interview.id}`,
      kind: 'result',
      appId: item.app.id,
      interviewId: item.interview.id,
      title: `${nameOf(item.app.companyId)} · ${item.app.jobTitle}`,
      detail: `${fmtDate(item.interview.scheduledAt)} 那场面试还没记结果`,
      tone: 'blue',
      doneHint: '去记结果',
    });
  }
  // ③ 黄：快截止了（窗口内但还没到今天）+ 该轻催 + 想投放太久
  for (const item of todos.deadline) {
    if (item.state.level === 'soon') pushDeadline(item, 'amber');
  }
  for (const item of todos.warn) {
    items.push({
      key: `warn_${item.app.id}`,
      kind: 'warn',
      appId: item.app.id,
      title: `${nameOf(item.app.companyId)} · ${item.app.jobTitle}`,
      detail: `${item.days} 天没动静，可以轻催一句`,
      tone: 'amber',
      doneHint: '催一下',
    });
  }
  for (const item of todos.wishlistExpired) {
    items.push({
      key: `wish_${item.app.id}`,
      kind: 'wishlist',
      appId: item.app.id,
      title: `${nameOf(item.app.companyId)} · ${item.app.jobTitle}`,
      detail: `放在想投里 ${item.days} 天了，还想投吗？`,
      tone: 'amber',
      doneHint: '做个决定',
    });
  }
  return items;
}

/* ------------------------------------------------------------- 行动预算 */

export interface DailyPlan {
  /** 今天真正要做的（前 budget 条，顺序同 buildActionItems） */
  primary: ActionItem[];
  /** 折叠起来的（还有多少件） */
  overflow: ActionItem[];
  total: number;
  /** 预算上限；0 表示不折叠 */
  budget: number;
}

/**
 * 今日行动预算。
 *
 * 为什么必须有这个东西：「12 件待办」和「0 件待办」对用户是同一种效果 —— 都不动。
 * 一个招聘季 60+ 条投递时，按沉默排序的待办会稳定停在 10~20 条，
 * 那不是「今天要做的事」，那是一份让人关掉页面的清单。
 *
 * 取舍：`primary` 严格取排序后的前 N 条，**不重新排序**（顺序即优先级，见 buildActionItems）。
 * `budget <= 0` 视为不限量，`overflow` 恒为空。
 */
export function buildDailyPlan(items: ActionItem[], budget: number): DailyPlan {
  const limit = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0;
  if (limit <= 0 || items.length <= limit) {
    return { primary: items, overflow: [], total: items.length, budget: limit };
  }
  return {
    primary: items.slice(0, limit),
    overflow: items.slice(limit),
    total: items.length,
    budget: limit,
  };
}

/* ----------------------------------------------------------------- 漏斗 */

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
  /** 相对上一阶段的转化率；第一阶段为 1 */
  rate: number;
}

/** 状态映射成「走到第几步」：0 想投 → 5 Offer */
export function stageRankOf(app: Application, interviews: Interview[]): number {
  switch (app.status) {
    case 'wishlist':
      return 0;
    case 'applied':
      return 1;
    case 'chatting':
      return 2;
    case 'scheduled':
      return 3;
    case 'interviewing':
      return 4;
    case 'offer':
    case 'onboarded':
      return 5;
    case 'rejected':
    case 'dropped': {
      // 终态没有记录「走到最远哪一步」，用面试记录与投递记录回推
      const own = interviews.filter((i) => i.applicationId === app.id);
      if (own.some((i) => i.result === 'passed' || i.result === 'failed')) return 3;
      if (own.length > 0) return 3;
      return app.appliedAt ? 1 : 0;
    }
    default:
      return 0;
  }
}

export function buildFunnel(db: DB): FunnelStage[] {
  const defs = [
    { key: 'wishlist', label: '想投', rank: 0 },
    { key: 'applied', label: '已投递', rank: 1 },
    { key: 'chatting', label: '已沟通', rank: 2 },
    { key: 'scheduled', label: '已约面', rank: 3 },
    { key: 'interviewing', label: '面试中', rank: 4 },
    { key: 'offer', label: 'Offer', rank: 5 },
  ];
  const ranks = db.applications.map((app) => stageRankOf(app, db.interviews));
  return defs.map((def, index) => {
    const count = ranks.filter((r) => r >= def.rank).length;
    const prev = index === 0 ? count : ranks.filter((r) => r >= defs[index - 1].rank).length;
    const rate = index === 0 ? (count > 0 ? 1 : 0) : prev > 0 ? count / prev : 0;
    return { key: def.key, label: def.label, count, rate };
  });
}

/** 本周投递量 */
export function weeklyAppliedCount(apps: Application[], now: Date = new Date()): number {
  const start = startOfWeek(now).getTime();
  const end = startOfWeek(now).getTime() + 7 * 24 * 60 * 60 * 1000;
  return apps.filter((app) => {
    const raw = app.appliedAt || app.createdAt;
    const ms = parseFlexible(raw).getTime();
    return Number.isFinite(ms) && ms >= start && ms < end;
  }).length;
}

/* ------------------------------------------------------------- 渠道/版本 */

export interface ChannelStat {
  channel: Channel;
  total: number;
  replied: number;
  rate: number;
}

/** 渠道回复率：走到「已沟通」及以后算有回复 */
export function buildChannelStats(db: DB): ChannelStat[] {
  const buckets = new Map<Channel, { total: number; replied: number }>();
  for (const app of db.applications) {
    const channel: Channel = app.channel || 'other';
    if (!buckets.has(channel)) buckets.set(channel, { total: 0, replied: 0 });
    const bucket = buckets.get(channel);
    if (!bucket) continue;
    bucket.total += 1;
    if (stageRankOf(app, db.interviews) >= 2) bucket.replied += 1;
  }
  return [...buckets.entries()]
    .map(([channel, v]) => ({
      channel,
      total: v.total,
      replied: v.replied,
      rate: v.total > 0 ? v.replied / v.total : 0,
    }))
    .sort((a, b) => b.total - a.total);
}

export interface ResumeStat {
  version: string;
  total: number;
  interviewed: number;
  rate: number;
}

/** 简历版本面试率：有任意面试记录算进面 */
export function buildResumeStats(db: DB): ResumeStat[] {
  const interviewAppIds = new Set(db.interviews.map((i) => i.applicationId));
  const buckets = new Map<string, { total: number; interviewed: number }>();
  for (const app of db.applications) {
    const version = app.resumeVersion || '未标注';
    if (!buckets.has(version)) buckets.set(version, { total: 0, interviewed: 0 });
    const bucket = buckets.get(version);
    if (!bucket) continue;
    bucket.total += 1;
    if (interviewAppIds.has(app.id)) bucket.interviewed += 1;
  }
  return [...buckets.entries()]
    .map(([version, v]) => ({
      version,
      total: v.total,
      interviewed: v.interviewed,
      rate: v.total > 0 ? v.interviewed / v.total : 0,
    }))
    .sort((a, b) => b.total - a.total);
}

export interface WeekBucket {
  label: string;
  /** 该周周一 */
  start: Date;
  count: number;
}

/** 最近 N 周投递量（最后一格是本周） */
export function buildWeeklyBuckets(apps: Application[], weeks = 8, now: Date = new Date()): WeekBucket[] {
  const thisMonday = startOfWeek(now);
  const buckets: WeekBucket[] = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const start = new Date(thisMonday.getTime());
    start.setDate(start.getDate() - i * 7);
    buckets.push({
      label: `${start.getMonth() + 1}/${start.getDate()}`,
      start,
      count: 0,
    });
  }
  for (const app of apps) {
    const raw = app.appliedAt || app.createdAt;
    const ms = parseFlexible(raw).getTime();
    if (!Number.isFinite(ms)) continue;
    for (let i = buckets.length - 1; i >= 0; i -= 1) {
      const start = buckets[i].start.getTime();
      const end = start + 7 * 24 * 60 * 60 * 1000;
      if (ms >= start && ms < end) {
        buckets[i].count += 1;
        break;
      }
    }
  }
  return buckets;
}

/* ------------------------------------------------------------- 冲突检测 */

export interface ConflictHit {
  messages: string[];
}

/** 面试时长（分钟），没填按 60 分钟估算 */
function durationOf(interview: Interview): number {
  return interview.durationMin && interview.durationMin > 0 ? interview.durationMin : 60;
}

interface Interval {
  start: number;
  end: number;
}

function intervalOf(interview: Interview): Interval {
  const start = parseFlexible(interview.scheduledAt);
  const startMs = start.getHours() * 60 + start.getMinutes();
  return { start: startMs, end: startMs + durationOf(interview) };
}

function overlap(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * 某天落地的日程：weekly 的按周几匹配，非 weekly 的按日期匹配。
 * 日历月格与侧栏都用它，口径只有这一份。
 */
export function eventsOnDate(events: CalendarEvent[], date: Date): CalendarEvent[] {
  const weekday = weekdayOf(date);
  const iso = toDateISO(date);
  return events.filter((event) => (event.weekly ? event.weekday === weekday : event.date === iso));
}

function eventInterval(event: CalendarEvent): Interval {
  return { start: timeToMinutes(event.start), end: timeToMinutes(event.end) };
}

/** 日程是否落在某天（供冲突检测用，与 eventsOnDate 同口径） */
function eventOnDate(event: CalendarEvent, date: Date): boolean {
  return event.weekly ? event.weekday === weekdayOf(date) : event.date === toDateISO(date);
}

/**
 * 面试时间冲突检测：同一天的其他面试 + 日历日程（课表导入的课、手动记的事）。
 * 冲突只警告，不阻止保存（日常实习的核心矛盾就是和上课/急事打架）。
 */
export function findConflicts(
  target: Interview,
  interviews: Interview[],
  applications: Application[],
  events: CalendarEvent[] = [],
): string[] {
  const messages: string[] = [];
  const targetAt = parseFlexible(target.scheduledAt);
  if (isNaN(targetAt.getTime())) return messages;
  const targetInterval = intervalOf(target);
  const appIndex = new Map<string, Application>();
  for (const app of applications) appIndex.set(app.id, app);

  // 1) 同一天的其他面试（跨公司也算冲突）
  for (const other of interviews) {
    if (other.id === target.id) continue;
    if (other.result === 'cancelled') continue;
    const otherAt = parseFlexible(other.scheduledAt);
    if (isNaN(otherAt.getTime())) continue;
    if (!isSameDay(otherAt, targetAt)) continue;
    if (!overlap(targetInterval, intervalOf(other))) continue;
    const app = appIndex.get(other.applicationId);
    const name = app ? app.jobTitle : '其他面试';
    messages.push(`与 ${fmtTime(other.scheduledAt)} 的另一场面试时间重叠（${name}）`);
  }

  // 2) 与日历日程冲突（课 / 任何事）
  for (const event of events) {
    if (!eventOnDate(event, targetAt)) continue;
    if (!overlap(targetInterval, eventInterval(event))) continue;
    messages.push(`与日程《${event.title || '未命名'}》冲突（${event.start}-${event.end}）`);
  }

  return messages;
}

/**
 * 一条日程的冲突检测：与面试撞、与其他日程撞（同一天 + 时间重叠）。
 * 日程之间的冲突也要报 —— 现实里「急事撞急事」同样致命。
 */
export function findEventConflicts(
  target: CalendarEvent,
  events: CalendarEvent[],
  interviews: Interview[],
  applications: Application[],
): string[] {
  const messages: string[] = [];
  const appIndex = new Map<string, Application>();
  for (const app of applications) appIndex.set(app.id, app);

  const targetDates = target.weekly ? null : target.date;
  const matchesDay = (date: Date): boolean =>
    target.weekly ? target.weekday === weekdayOf(date) : targetDates === toDateISO(date);

  for (const interview of interviews) {
    if (interview.result === 'cancelled') continue;
    const at = parseFlexible(interview.scheduledAt);
    if (isNaN(at.getTime())) continue;
    if (!matchesDay(at)) continue;
    if (!overlap(eventInterval(target), intervalOf(interview))) continue;
    const app = appIndex.get(interview.applicationId);
    messages.push(
      `与 ${fmtTime(interview.scheduledAt)} 的面试重叠（${app ? app.jobTitle : '某场面试'}）`,
    );
  }

  for (const other of events) {
    if (other.id === target.id) continue;
    if (other.weekly !== target.weekly) {
      // 一边是「每周固定」一边是「某天」：只有非 weekly 那天的周几匹配才算
      const fixed = other.weekly ? other : target;
      const dated = other.weekly ? target : other;
      if (dated.weekly || !dated.date) continue;
      const date = parseFlexible(`${dated.date}T12:00:00`);
      if (isNaN(date.getTime()) || fixed.weekday !== weekdayOf(date)) continue;
    } else if (target.weekly) {
      if (other.weekday !== target.weekday) continue;
    } else {
      if (!other.date || other.date !== target.date) continue;
    }
    if (!overlap(eventInterval(target), eventInterval(other))) continue;
    messages.push(`与日程《${other.title || '未命名'}》冲突（${other.start}-${other.end}）`);
  }

  return messages;
}

/* ------------------------------------------------------------- 建议动作 */

export type SuggestKind = 'followup' | 'open' | 'schedule' | 'confirm' | 'reapply' | 'apply';

export interface Suggestion {
  label: string;
  kind: SuggestKind;
}

/** 每张卡片右侧永远只有一个建议动作 —— 系统按状态 + 沉默天数算出唯一解 */
export function suggestionFor(app: Application, silence: SilenceState): Suggestion {
  switch (app.status) {
    case 'wishlist':
      return { label: '去投递', kind: 'apply' };
    case 'applied':
    case 'chatting':
      return silence.level === 'stale'
        ? { label: '去催一下', kind: 'followup' }
        : { label: '约面试', kind: 'schedule' };
    case 'scheduled':
      return { label: '看准备清单', kind: 'open' };
    case 'interviewing':
      return { label: '记结果', kind: 'open' };
    case 'offer':
      return { label: '确认到岗', kind: 'confirm' };
    case 'onboarded':
      return { label: '已入职', kind: 'open' };
    case 'rejected':
      return { label: '看复盘', kind: 'open' };
    case 'dropped':
      return { label: '重投', kind: 'reapply' };
    default:
      return { label: '打开详情', kind: 'open' };
  }
}

/* --------------------------------------------------------------- 话术 */

/** 按沉默天数与状态生成可直接复制的中文催问话术（3 天轻催 / 7 天确认两档） */
export function buildFollowupScript(app: Application, companyName: string, silenceDays: number): string {
  const job = app.jobTitle || '这个实习岗位';
  const company = companyName || '贵公司';
  const applied = app.appliedAt ? fmtDate(app.appliedAt) : '';
  if (silenceDays >= 7) {
    return `您好，我是${applied ? `${applied} ` : ''}投递${company}「${job}」的候选人。想再确认一下这个岗位目前的进度，如果暂时没有合适安排也麻烦告知一声，我好调整时间安排。方便的话我可以补一份项目说明，谢谢您！`;
  }
  return `您好，上周投递了${company}的「${job}」，想再确认下进度～我这边每周可以到岗${
    app.daysPerWeek ? `${app.daysPerWeek} 天` : '3 天'
  }${app.durationMonths ? `、可连续实习 ${app.durationMonths} 个月` : ''}，随时可以安排面试。麻烦您了！`;
}

/** 状态变更时写入时间线的系统文案 */
export function statusChangeText(from: Status, to: Status): string {
  return `状态：${STATUS_LABEL[from]} → ${STATUS_LABEL[to]}`;
}

/* ------------------------------------------------------- 已挂：挂在哪一轮 */

/**
 * HR 面在数据里统一记作「第 4 轮」。
 * 理由：rejectedAtRound 是 number|null，不新增字段、不升 schemaVersion；
 * 实习流程几乎不会出现真正的第 4 轮技术面，所以这个映射在实践中不会撞车，
 * 同时保留「能按轮次排序」这个复盘价值。
 */
export const HR_ROUND = 4;

export interface RejectRoundOption {
  value: number | null;
  label: string;
}

/** 「标为已挂」后的小选择区档位 —— 选完或不选都能保存 */
export const REJECT_ROUND_OPTIONS: RejectRoundOption[] = [
  { value: 1, label: '第 1 轮' },
  { value: 2, label: '第 2 轮' },
  { value: 3, label: '第 3 轮' },
  { value: HR_ROUND, label: 'HR 面' },
  { value: null, label: '不记得了' },
];

/** 挂在第几轮的口语化文案；空值统一显示「轮次未记」 */
export function rejectedRoundLabel(round?: number | null): string {
  if (round === null || round === undefined || !Number.isFinite(round) || round <= 0) return '轮次未记';
  if (round === HR_ROUND) return '第 4 轮（HR 面）';
  return `第 ${round} 轮`;
}

/** 简短版，给看板角标 / 列表小字用 */
export function rejectedRoundShort(round?: number | null): string {
  if (round === null || round === undefined || !Number.isFinite(round) || round <= 0) return '轮次未记';
  if (round === HR_ROUND) return 'HR 面';
  return `第 ${round} 轮`;
}

/* ---------------------------------------------------------- 状态变更撤销 */

/**
 * 一次状态变更的「影响面」快照。
 * 撤销只回滚这几个字段 + 按 id 精确删除本次产生的那条 system 记录，
 * 绝不整库替换 —— 否则用户在状态变更之后手写的备注/面试/设置会被无声吞掉。
 */
export interface StatusUndo {
  appId: string;
  prevStatus: Status;
  prevStatusChangedAt: string;
  prevLastActivityAt: string;
  prevRejectedAtRound: number | null;
  /** 本次状态变更自动写入的那条系统时间线 id */
  createdNoteId: string;
}

/**
 * 在 draft 上原地撤销一次状态变更（供 App.mutate 调用，纯函数便于单测）。
 * 关键：只删 undo.createdNoteId 这一条，其他 note 一律不动；
 * lastActivityAt 用「旧的状态变更时间 + 现有时间线」重算，所以用户撤销前手写的备注仍然生效。
 */
export function revertStatusChange(draft: DB, undo: StatusUndo): void {
  draft.notes = draft.notes.filter((note) => note.id !== undo.createdNoteId);
  const target = draft.applications.find((app) => app.id === undo.appId);
  if (!target) return;
  target.status = undo.prevStatus;
  target.statusChangedAt = undo.prevStatusChangedAt;
  target.rejectedAtRound = undo.prevRejectedAtRound;
  target.lastActivityAt = lastActivityAtOf(target, draft.notes);
  target.updatedAt = new Date().toISOString();
}

/* ------------------------------------------------------ 删除投递的撤销包 */

/**
 * 删除一条投递时被一并移走的东西。
 *
 * 只装「这一条投递影响到的行」，不复制整库 —— 与 StatusUndo 同样的原则：
 * 撤销删除不能把用户在删除之后写的其他备注顺手吞掉。
 */
export interface DeletedApplication {
  app: Application;
  interviews: Interview[];
  notes: Note[];
  /** 被解绑（applicationId 置 null）的面经 id；恢复时只认仍是 null 的，避免抢别人的绑定 */
  experienceIds: string[];
}

/** 在 draft 上原地恢复一条被删除的投递（幂等：已存在的 id 不重复插入） */
export function restoreDeletedApplication(draft: DB, deleted: DeletedApplication): void {
  if (!draft.applications.some((app) => app.id === deleted.app.id)) {
    draft.applications.push(deleted.app);
  }
  const interviewIds = new Set(draft.interviews.map((item) => item.id));
  for (const interview of deleted.interviews) {
    if (!interviewIds.has(interview.id)) draft.interviews.push(interview);
  }
  const noteIds = new Set(draft.notes.map((item) => item.id));
  for (const note of deleted.notes) {
    if (!noteIds.has(note.id)) draft.notes.push(note);
  }
  for (const id of deleted.experienceIds) {
    const experience = draft.experiences.find((item) => item.id === id);
    if (experience && experience.applicationId === null) experience.applicationId = deleted.app.id;
  }
}

/** 供日历用：某一天的所有面试 */
export function interviewsOnDay(interviews: Interview[], day: Date): Interview[] {
  const key = toDateISO(startOfDay(day));
  return interviews
    .filter((i) => toDateISO(startOfDay(i.scheduledAt)) === key)
    .sort((a, b) => parseFlexible(a.scheduledAt).getTime() - parseFlexible(b.scheduledAt).getTime());
}
