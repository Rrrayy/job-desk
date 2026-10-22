/**
 * 表格 / 日历导出 —— 全部是**纯函数**，不碰 DOM、不读系统时间（now 由调用方注入）。
 *
 * 为什么单独一个模块而不是塞进 storage.ts：
 * storage 负责「本应用自己的备份格式」（JSON，可往返），
 * 这里负责「给别的软件看」的格式（CSV 进 Excel、ICS 进日历）。
 * 两者的兼容性契约完全不同：JSON 必须**无损往返**，CSV/ICS 一旦导出就是单向的，
 * 所以这里可以做「为了对方好用而牺牲信息」的事（加 BOM、丢掉非标准字段、把 UTC 写死）。
 */

import type { Application, DB, Interview } from '../types';
import { fmtDate, parseFlexible, toDateISO } from './date';
import {
  CHANNEL_LABEL,
  JOB_TYPE_LABEL,
  RESULT_LABEL,
  SILENCE_STATUSES,
  STATUS_LABEL,
  buildNoteIndex,
  currentRoundOf,
  effectiveStaleDays,
  interviewKindLabel,
  rejectedRoundShort,
  silenceDaysOf,
} from './rules';

/** 任意时间字段 → 本地 YYYY-MM-DD；解析不出来就给空串（宁缺勿错） */
function localDateOf(value: string | null | undefined): string {
  if (!value) return '';
  const d = parseFlexible(value);
  return isNaN(d.getTime()) ? '' : toDateISO(d);
}

/* ------------------------------------------------------------------ CSV */

/**
 * CSV 单元格转义。
 *
 * 两件事必须做，缺一行都是 bug：
 * 1. RFC 4180：含 `,` `"` 换行的值要整体加引号，内部 `"` 变 `""`；
 * 2. **防公式注入**：Excel / Numbers 会把以 `= + - @` 开头的单元格当公式执行。
 *    用户在公司名里写 `=1+1` 是玩笑，写 `=cmd|...` 就是安全问题。
 *    标准做法是前置一个单引号把它钉成文本 —— 代价是 `-` 开头的负数会多一个 `'`，
 *    所以只对「不是纯数字」的值生效。
 */
function csvCell(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  const text = String(raw);
  if (!text) return '';
  const risky = /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text);
  const guarded = risky ? `'${text}` : text;
  if (/[",\r\n]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`;
  return guarded;
}

export const APPLICATION_CSV_HEADER = [
  '公司',
  '岗位',
  '状态',
  '渠道',
  '实习类型',
  '城市',
  '投递日期',
  '截止日期',
  '当前轮次',
  '面试类型',
  '最近互动',
  '沉默天数',
  '沉默阈值',
  '简历版本',
  '心动',
  '薪资原文',
  'JD 链接',
] as const;

/**
 * 「当前轮次」列：已挂行显示挂点（0 → 笔试），其余显示最新一条 pending 面试的轮次。
 * 与看板徽章共用 currentRoundOf / rejectedRoundShort 同一口径，导出导入才能对上账。
 */
function roundCellOf(app: Application, interviews: Interview[]): string {
  if (app.status === 'rejected') return rejectedRoundShort(app.rejectedAtRound);
  const current = currentRoundOf(app, interviews);
  if (!current) return '';
  if (current.round === 0 || current.kind === 'written') return '笔试';
  return `第 ${current.round} 轮`;
}

/** 「面试类型」列：取当前轮次那场的类型；未标注（老数据）给空串 */
function roundKindCellOf(app: Application, interviews: Interview[]): string {
  if (app.status === 'rejected') {
    const own = interviews.filter((item) => item.applicationId === app.id);
    const failed = own.find((item) => item.result === 'failed');
    if (failed) return interviewKindLabel(failed.kind);
    return '';
  }
  const current = currentRoundOf(app, interviews);
  return current ? interviewKindLabel(current.kind) : '';
}

/**
 * 投递表 CSV。
 *
 * 口径说明（避免用户拿去算的时候对不上账）：
 * - 「沉默天数」按自然日算，与今日视图完全同一个函数（silenceDaysOf），不另写一份；
 * - 「沉默阈值」是该投递**实际生效**的阈值（已含渠道系数 / 单独覆盖 / offer 规则），
 *   这样用户一眼能看出「为什么这家 12 天没红」；
 * - 人已入职 / 已挂 / 已放弃也照样导出 —— 复盘要的是全量，不是只看进行中的；
 * - v0.8：「当前轮次」「面试类型」两列与 csvImport 的别名表对齐，保证往返无损失。
 */
export function buildApplicationsCSV(db: DB, now: Date = new Date()): string {
  const companyName = new Map<string, string>();
  for (const company of db.companies) {
    companyName.set(company.id, company.shortName || company.name);
  }

  const rows: string[] = [APPLICATION_CSV_HEADER.map(csvCell).join(',')];
  const noteIndex = buildNoteIndex(db.notes);
  const sorted = [...db.applications].sort((a, b) => {
    const av = a.appliedAt || a.createdAt;
    const bv = b.appliedAt || b.createdAt;
    return av < bv ? 1 : av > bv ? -1 : 0;
  });

  for (const app of sorted) {
    const silenced = SILENCE_STATUSES.includes(app.status);
    rows.push(
      [
        csvCell(companyName.get(app.companyId) ?? '未知公司'),
        csvCell(app.jobTitle),
        csvCell(STATUS_LABEL[app.status]),
        csvCell(app.channel ? CHANNEL_LABEL[app.channel] : ''),
        csvCell(app.jobType ? JOB_TYPE_LABEL[app.jobType] : ''),
        csvCell(app.city),
        csvCell(app.appliedAt || localDateOf(app.createdAt)),
        csvCell(app.deadlineAt ?? ''),
        csvCell(roundCellOf(app, db.interviews)),
        csvCell(roundKindCellOf(app, db.interviews)),
        csvCell(localDateOf(app.lastActivityAt)),
        csvCell(silenced ? silenceDaysOf(app, db.notes, now, noteIndex) : ''),
        csvCell(silenced ? effectiveStaleDays(app, db.settings) : ''),
        csvCell(app.resumeVersion),
        csvCell(app.priority ?? ''),
        csvCell(app.salaryText),
        csvCell(app.jdUrl),
      ].join(','),
    );
  }

  // BOM：没有它 Excel 会把中文读成乱码，这是「导出能不能用」的分水岭
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}

/** 文件名里的日期一律走本地日期，不用 toISOString()（UTC 会在早上 8 点前少一天） */
export function csvFilename(now: Date = new Date()): string {
  return `求职工作台-投递-${toDateISO(now)}.csv`;
}

/* ------------------------------------------------------------------ ICS */

const CRLF = '\r\n';

/** RFC 5545 TEXT 转义：反斜杠 → 分号 → 逗号 → 换行，顺序不能换 */
function icsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * 按 RFC 5545 §3.1 折行：每行不超过 75 个**八位组**，续行以单个空格开头。
 *
 * 为什么不能用 `line.slice(0, 75)`：那是切「字符」不是切「字节」，
 * 一个中文占 3 个字节，75 个中文 = 225 字节，超出规范上限；
 * 更糟的是 slice 可能把代理对（emoji）切成两半，落地就是乱码。
 * 所以用 `for...of` 按码点迭代 + TextEncoder 量字节。
 */
function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  let limit = 75;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > limit) {
      parts.push(current);
      current = char;
      bytes = size;
      limit = 74; // 续行前面那个空格也算一个八位组
    } else {
      current += char;
      bytes += size;
    }
  }
  if (current) parts.push(current);
  return parts.join(`${CRLF} `);
}

function pad2(value: number): string {
  return `${value}`.padStart(2, '0');
}

/** 本地时间 → ICS 的 UTC 形式（YYYYMMDDTHHMMSSZ）。日历跨设备时区才不会漂 */
function icsStamp(value: string): string | null {
  const d = parseFlexible(value);
  if (isNaN(d.getTime())) return null;
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  );
}

function eventOf(interview: Interview, db: DB, stamp: string): string[] | null {
  const start = parseFlexible(interview.scheduledAt);
  if (isNaN(start.getTime())) return null;
  const durationMin = interview.durationMin && interview.durationMin > 0 ? interview.durationMin : 60;
  const end = new Date(start.getTime() + durationMin * 60 * 1000);
  const startStamp = icsStamp(interview.scheduledAt);
  const endStamp = icsStamp(end.toISOString());
  if (!startStamp || !endStamp) return null;

  const app = db.applications.find((item) => item.id === interview.applicationId);
  const company = app ? db.companies.find((item) => item.id === app.companyId) : undefined;
  const companyName = company ? company.shortName || company.name : '未知公司';
  const jobTitle = app ? app.jobTitle : '面试';

  const summary = `${companyName} · ${jobTitle}（第 ${interview.round} 轮）`;
  const description = [
    `第 ${interview.round} 轮${interview.totalRounds ? ` / 共 ${interview.totalRounds} 轮` : ''}`,
    `形式：${interview.format === 'onsite' ? '现场' : interview.format === 'video' ? '视频' : '电话'}`,
    `结果：${RESULT_LABEL[interview.result]}`,
    interview.interviewer ? `面试官：${interview.interviewer}` : '',
    interview.notes ? `备注：${interview.notes}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const lines = [
    'BEGIN:VEVENT',
    // UID 用本地 id + 固定域名：重复导入同一个 ICS 时，日历会按 UID 去重而不是塞两份
    `UID:${interview.id}@job-desk.local`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${startStamp}`,
    `DTEND:${endStamp}`,
    `SUMMARY:${icsText(summary)}`,
    `DESCRIPTION:${icsText(description)}`,
  ];
  if (interview.locationOrLink) lines.push(`LOCATION:${icsText(interview.locationOrLink)}`);
  // 已取消的场次不删，标成 CANCELLED —— 删掉的话重新导入会把旧事件留在日历里
  if (interview.result === 'cancelled') lines.push('STATUS:CANCELLED');
  lines.push('END:VEVENT');
  return lines;
}

/**
 * 面试日历 ICS。
 *
 * 只导面试，不导截止 —— 截止没有「几点」，做成全天事件会污染日历的视觉密度；
 * 真要提醒截止，用「今天要做的 N 件事」比日历更合适。
 */
export function buildInterviewsICS(db: DB, now: Date = new Date()): string {
  const stamp = icsStamp(now.toISOString()) ?? '19700101T000000Z';
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//job-desk//求职工作台//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  const sorted = [...db.interviews].sort(
    (a, b) => parseFlexible(a.scheduledAt).getTime() - parseFlexible(b.scheduledAt).getTime(),
  );
  for (const interview of sorted) {
    const event = eventOf(interview, db, stamp);
    if (event) lines.push(...event);
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join(CRLF)}${CRLF}`;
}

export function icsFilename(now: Date = new Date()): string {
  return `求职工作台-面试-${toDateISO(now)}.ics`;
}

/** 导出按钮上显示的数量，避免用户导出一个空的 CSV/ICS 还不知道为什么 */
export function exportPreview(db: DB): { applications: number; interviews: number; firstDate: string } {
  const first = [...db.interviews].sort(
    (a, b) => parseFlexible(a.scheduledAt).getTime() - parseFlexible(b.scheduledAt).getTime(),
  )[0];
  return {
    applications: db.applications.length,
    interviews: db.interviews.length,
    firstDate: first ? fmtDate(first.scheduledAt, '') : '',
  };
}
