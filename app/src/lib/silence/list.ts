/**
 * 模块四 · 沉默待办清单的派生与批量计划（纯函数，零 React / 零 IO）。
 *
 * 三条读图规则（SIL-1，界面必须照此渲染）：
 * 1. **分组只看 `silence.level`**，不按天数硬切 —— 内推阈值 ×3，所以「内推 10 天」是黄不是红；
 * 2. 红组里 15 天处只画一条分割线，**不建子组**（只有一套计数口径，用户才对得上账）；
 * 3. 静音的条目**仍留在原组**（灰显 + ⌛），不单独成组 —— 否则「7 条」这个数字会随静音状态变化。
 */

import type { Application, Company, DB } from '../../types';
import {
  buildNoteIndex,
  CHANNEL_LABEL,
  isMuted,
  muteRemainDays,
  silenceStateOf,
  suggestionFor,
  type SilenceState,
  type Suggestion,
} from '../rules';
import { addDays, parseFlexible, toDateISO } from '../date';

/** 一次最多渲染的条数（D-11：不做虚拟滚动，「分组 + 分割线 + 批量勾选」与固定行高的虚拟列表是两套结构） */
export const SILENCE_RENDER_LIMIT = 200;

/** 红组内的分割线位置（天） */
export const STALE_SPLIT_DAYS = 15;

export interface SilenceRow {
  app: Application;
  company: Company | undefined;
  silence: SilenceState;
  muted: boolean;
  muteRemain: number | null;
  suggestion: Suggestion;
}

export interface SilenceGroups {
  /** 红「已沉默」：**只看 silence.level === 'stale'**，不按天数硬切 */
  stale: SilenceRow[];
  /** 黄「该跟进」 */
  warn: SilenceRow[];
  /** 红组内 15 天分割线的插入下标（第一个 days < 15 的位置；-1 = 不插） */
  staleSplitAt: number;
  /** 两组条数之和（hideMuted=false 时 = 全库 level !== null 的投递数） */
  total: number;
  /** 静音条目数（含被隐藏的） */
  mutedTotal: number;
}

/**
 * 全库沉默行：只收 `level !== null` 的未删除投递，按沉默天数降序。
 * 一次建索引（O(note)），避免每行重复扫全库时间线。
 */
export function silenceRowsOf(db: DB, now: Date): SilenceRow[] {
  const noteIndex = buildNoteIndex(db.notes);
  const companyById = new Map(db.companies.map((company) => [company.id, company]));
  const rows: SilenceRow[] = [];
  for (const app of db.applications) {
    if (app.deletedAt) continue;
    const silence = silenceStateOf(app, db.notes, db.settings, now, noteIndex);
    if (silence.level === null) continue;
    rows.push({
      app,
      company: companyById.get(app.companyId),
      silence,
      muted: isMuted(app, now),
      muteRemain: muteRemainDays(app, now),
      suggestion: suggestionFor(app, silence),
    });
  }
  return rows.sort((a, b) => b.silence.days - a.silence.days);
}

/** 分组（组内顺序沿用传入顺序 = 天数降序） */
export function buildSilenceGroups(rows: SilenceRow[], opts: { hideMuted: boolean }): SilenceGroups {
  const mutedTotal = rows.filter((row) => row.muted).length;
  const visible = opts.hideMuted ? rows.filter((row) => !row.muted) : rows;
  const stale = visible.filter((row) => row.silence.level === 'stale');
  const warn = visible.filter((row) => row.silence.level === 'warn');
  const splitIndex = stale.findIndex((row) => row.silence.days < STALE_SPLIT_DAYS);
  return {
    stale,
    warn,
    staleSplitAt: splitIndex,
    total: stale.length + warn.length,
    mutedTotal,
  };
}

/**
 * SIL-3：返回真正要写 note 的 id —— **只有用户确认「已发出」的才写**。
 * 生成话术 ≠ 发了消息；一步到位会把没发的记录全刷成绿色，那是在骗自己。
 */
export function planBatchFollowup(ids: string[], confirmedIds: string[]): string[] {
  const confirmed = new Set(confirmedIds);
  return ids.filter((id) => confirmed.has(id));
}

/** 静音预设（SIL-5）。'nextWeek' = 下周同一天的 23:59:59，不是「7×24 小时后」 */
export type SilenceMutePreset = '3d' | 'nextWeek' | string;

/**
 * SIL-5：`'3d' | 'nextWeek' | 'YYYY-MM-DD'` → 每条一个 ISO（统一到当日 23:59:59.999）。
 * 用「当天结束」而不是 `now + N×24h`：用户说「静音 3 天」的意思是「这三天别再提它」。
 */
export function planBatchMute(
  ids: string[],
  preset: SilenceMutePreset,
  now: Date,
): Array<{ id: string; mutedUntil: string }> {
  let target: Date;
  if (preset === '3d') {
    target = addDays(now, 3);
  } else if (preset === 'nextWeek') {
    target = addDays(now, 7);
  } else {
    const parsed = parseFlexible(preset);
    target = Number.isNaN(parsed.getTime()) ? addDays(now, 7) : parsed;
  }
  const end = new Date(target.getTime());
  end.setHours(23, 59, 59, 999);
  const iso = end.toISOString();
  return ids.map((id) => ({ id, mutedUntil: iso }));
}

/** 静音角标文案：'静音到 3/20'（组件不拼日期） */
export function muteLabelOf(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = parseFlexible(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `静音到 ${toDateISO(date).slice(5).replace('-', '/')}`;
}

/**
 * SIL-8（P1）：Markdown 表格，行数 = 传入行数（导出条数必须与当前筛选结果相等）。
 */
export function silenceListToMarkdown(rows: SilenceRow[]): string {
  const lines: string[] = [];
  lines.push('| 公司 | 岗位 | 沉默天数 | 渠道 | 状态 | 建议动作 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const row of rows) {
    const company = row.company ? row.company.shortName || row.company.name : '未知公司';
    const channel = row.app.channel ? CHANNEL_LABEL[row.app.channel] : '—';
    lines.push(
      `| ${company} | ${row.app.jobTitle} | ${row.silence.days} | ${channel} | ${
        row.silence.text
      } | ${row.suggestion.label} |`,
    );
  }
  return lines.join('\n');
}
