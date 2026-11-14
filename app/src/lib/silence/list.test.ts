/**
 * 模块四 · 沉默待办清单的派生与批量计划（PRD §3.4 SIL-1 ~ SIL-8）。
 *
 * 三条读图规则在这里钉住（界面必须照此渲染）：
 * 1. 分组只看 `silence.level`，**不按天数硬切** —— 内推 ×3，所以「内推 10 天」是黄不是红；
 * 2. 红组里 15 天处只画一条分割线，不建子组（只有一套计数口径，用户才对得上账）；
 * 3. 静音的条目**仍留在原组**（灰显），不单独成组 —— 否则组内数字会随静音状态变化。
 *
 * ★ 沉默基准是 `lastActivityAtOf(app, notes)` = max(statusChangedAt, 最近一条 note)，
 *   不是 `app.lastActivityAt` 这个落库派生值 —— 所以造数据要改 `statusChangedAt`。
 */

import { describe, expect, it } from 'vitest';
import type { Application, Company, DB, Note } from '../../types';
import { emptyDB } from '../defaults';
import { toDateISO } from '../date';
import {
  SILENCE_RENDER_LIMIT,
  STALE_SPLIT_DAYS,
  buildSilenceGroups,
  muteLabelOf,
  planBatchFollowup,
  planBatchMute,
  silenceListToMarkdown,
  silenceRowsOf,
} from './list';

const NOW = new Date(2026, 9, 26, 9, 0, 0);

/** 造一个「n 天前有过活动」的时间戳 */
function daysAgo(n: number): string {
  const d = new Date(NOW.getTime());
  d.setDate(d.getDate() - n);
  d.setHours(10, 0, 0, 0);
  return d.toISOString();
}

function makeCompany(id: string, name: string, shortName?: string): Company {
  return shortName
    ? { id, name, shortName, createdAt: '2026-09-01T00:00:00.000Z' }
    : { id, name, createdAt: '2026-09-01T00:00:00.000Z' };
}

/** 沉默 n 天的投递（沉默基准 = statusChangedAt，所以这里必须一起改） */
function silentApp(id: string, days: number, overrides: Partial<Application> = {}): Application {
  const app: Application = {
    id,
    companyId: 'c1',
    jobTitle: `岗位 ${id}`,
    status: 'applied',
    statusChangedAt: daysAgo(days),
    lastActivityAt: daysAgo(days),
    createdAt: daysAgo(days + 10),
    updatedAt: daysAgo(days),
    ...overrides,
  };
  return app;
}

function makeDB(apps: Application[], notes: Note[] = []): DB {
  const db = emptyDB();
  db.companies = [makeCompany('c1', '字节跳动', '字节'), makeCompany('c2', '美团')];
  db.applications = apps;
  db.notes = notes;
  return db;
}

/** 未来 3 天有效的静音 */
function mutedFor3Days(): string {
  return new Date(2026, 9, 29, 23, 59, 59, 999).toISOString();
}

describe('silenceRowsOf · 谁能进清单', () => {
  it('★ 内推 10 天在「黄组」而不是红组（阈值 ×3，只有一套真相）', () => {
    const db = makeDB([
      silentApp('a1', 10, { channel: 'referral' }),
      // 同样 10 天，但没走内推 → 早就红了
      silentApp('a2', 10),
    ]);
    const byId = new Map(silenceRowsOf(db, NOW).map((row) => [row.app.id, row]));
    expect(byId.get('a1')?.silence.days).toBe(10);
    expect(byId.get('a1')?.silence.level).toBe('warn');
    expect(byId.get('a2')?.silence.level).toBe('stale');
  });

  it('收不到的状态（想投 / 已挂 / 已入职）不进清单', () => {
    const db = makeDB([
      silentApp('a1', 99, { status: 'wishlist' }),
      silentApp('a2', 99, { status: 'rejected' }),
      silentApp('a3', 99, { status: 'onboarded' }),
    ]);
    expect(silenceRowsOf(db, NOW)).toEqual([]);
  });

  it('回收站里的不算（删了还看得见是最伤信任的 bug）', () => {
    const db = makeDB([silentApp('a1', 30, { deletedAt: daysAgo(1) }), silentApp('a2', 30)]);
    expect(silenceRowsOf(db, NOW).map((row) => row.app.id)).toEqual(['a2']);
  });

  it('按沉默天数降序（最该处理的在最上面）', () => {
    const db = makeDB([silentApp('a1', 8), silentApp('a2', 30), silentApp('a3', 15)]);
    expect(silenceRowsOf(db, NOW).map((row) => row.silence.days)).toEqual([30, 15, 8]);
  });

  it('★ 新增一条 note 会刷新沉默基准：红标立刻消失，条目也离开清单', () => {
    const note: Note = {
      id: 'n1',
      applicationId: 'a1',
      type: 'followup',
      content: '催了一下',
      touchedAt: daysAgo(1),
    };
    const db = makeDB([silentApp('a1', 30)], [note]);
    // 沉默基准是 max(statusChangedAt, 最近 note) → 现在只有 1 天，不够警戒线
    expect(silenceRowsOf(db, NOW)).toEqual([]);
  });

  it('静音标记与剩余天数随行带出（灰显 + ⌛ 由组件渲染）', () => {
    const db = makeDB([silentApp('a1', 30, { mutedUntil: mutedFor3Days() })]);
    const [row] = silenceRowsOf(db, NOW);
    expect(row.muted).toBe(true);
    expect(row.muteRemain).toBe(3);
  });

  it('过期静音不再算静音（到期就该重新提醒）', () => {
    const db = makeDB([silentApp('a1', 30, { mutedUntil: daysAgo(1) })]);
    expect(silenceRowsOf(db, NOW)[0].muted).toBe(false);
  });

  it('建议动作跟着状态与分组走（红组才是「去催一下」）', () => {
    const db = makeDB([
      silentApp('a1', 30),
      silentApp('a2', 4),
      silentApp('a3', 30, { status: 'offer' }),
    ]);
    const byId = new Map(silenceRowsOf(db, NOW).map((row) => [row.app.id, row]));
    expect(byId.get('a1')?.suggestion).toEqual({ label: '去催一下', kind: 'followup' });
    expect(byId.get('a2')?.suggestion).toEqual({ label: '约面试', kind: 'schedule' });
    expect(byId.get('a3')?.suggestion.label).toBe('确认到岗');
  });
});

describe('buildSilenceGroups · 分组与分割线', () => {
  function rows(): ReturnType<typeof silenceRowsOf> {
    return silenceRowsOf(
      makeDB([silentApp('a1', 25), silentApp('a2', 20), silentApp('a3', 12), silentApp('a4', 4)]),
      NOW,
    );
  }

  it('红组 = level stale，黄组 = level warn，组内顺序沿用天数降序', () => {
    const groups = buildSilenceGroups(rows(), { hideMuted: false });
    expect(groups.stale.map((row) => row.silence.days)).toEqual([25, 20, 12]);
    expect(groups.warn.map((row) => row.silence.days)).toEqual([4]);
    expect(groups.total).toBe(4);
  });

  it('★ 红组里 15 天处只有一条分割线，不建子组：分割下标 = 第一个 < 15 的位置', () => {
    const groups = buildSilenceGroups(rows(), { hideMuted: false });
    expect(STALE_SPLIT_DAYS).toBe(15);
    expect(groups.staleSplitAt).toBe(2);
  });

  it('全部 ≥ 15 天 → 分割线不插（-1）', () => {
    const groups = buildSilenceGroups(
      silenceRowsOf(makeDB([silentApp('a1', 30)]), NOW),
      { hideMuted: false },
    );
    expect(groups.staleSplitAt).toBe(-1);
  });

  it('★ 静音的条目仍留在原组（不单独成组），只是标了 muted', () => {
    const db = makeDB([silentApp('a1', 25, { mutedUntil: mutedFor3Days() }), silentApp('a2', 20)]);
    const groups = buildSilenceGroups(silenceRowsOf(db, NOW), { hideMuted: false });
    expect(groups.stale).toHaveLength(2);
    expect(groups.stale[0].muted).toBe(true);
    expect(groups.mutedTotal).toBe(1);
    expect(groups.total).toBe(2);
  });

  it('「隐藏已静音」只影响可见条数，mutedTotal 仍照实报（角标要能说明「藏了几条」）', () => {
    const db = makeDB([silentApp('a1', 25, { mutedUntil: mutedFor3Days() }), silentApp('a2', 20)]);
    const groups = buildSilenceGroups(silenceRowsOf(db, NOW), { hideMuted: true });
    expect(groups.stale).toHaveLength(1);
    expect(groups.total).toBe(1);
    expect(groups.mutedTotal).toBe(1);
  });

  it('空清单：两组为空、total 为 0，不抛异常', () => {
    expect(buildSilenceGroups([], { hideMuted: false })).toEqual({
      stale: [],
      warn: [],
      staleSplitAt: -1,
      total: 0,
      mutedTotal: 0,
    });
  });

  it('渲染上限常量是 200（不做虚拟滚动，靠上限兜底）', () => {
    expect(SILENCE_RENDER_LIMIT).toBe(200);
  });
});

describe('planBatchFollowup · SIL-3 两步：生成话术 ≠ 已发出', () => {
  it('★ 只有用户确认「已发出」的才写 note（否则等于骗自己）', () => {
    expect(planBatchFollowup(['a1', 'a2', 'a3'], ['a1', 'a3'])).toEqual(['a1', 'a3']);
  });

  it('一个都没确认 → 一条都不写', () => {
    expect(planBatchFollowup(['a1', 'a2'], [])).toEqual([]);
  });

  it('确认了不在勾选里的 id → 忽略（不越界写别人）', () => {
    expect(planBatchFollowup(['a1'], ['a9'])).toEqual([]);
  });
});

describe('planBatchMute · SIL-5 静音预设', () => {
  it('「3 天」= 第 3 天的 23:59:59.999（不是 72 小时后）', () => {
    expect(planBatchMute(['a1', 'a2'], '3d', NOW)).toEqual([
      { id: 'a1', mutedUntil: new Date(2026, 9, 29, 23, 59, 59, 999).toISOString() },
      { id: 'a2', mutedUntil: new Date(2026, 9, 29, 23, 59, 59, 999).toISOString() },
    ]);
  });

  it('「下周」= 7 天后那一天的 23:59:59', () => {
    expect(planBatchMute(['a1'], 'nextWeek', NOW)[0].mutedUntil).toBe(
      new Date(2026, 10, 2, 23, 59, 59, 999).toISOString(),
    );
  });

  it('指定日期 → 那一天结束（YYYY-MM-DD 按本地零点解析）', () => {
    const result = planBatchMute(['a1'], '2026-12-25', NOW);
    expect(toDateISO(new Date(result[0].mutedUntil))).toBe('2026-12-25');
    expect(new Date(result[0].mutedUntil).getHours()).toBe(23);
  });

  it('无法解析的日期 → 回落「下周」（不抛异常、不静音到 Invalid Date）', () => {
    const result = planBatchMute(['a1'], '下个月吧', NOW);
    expect(result[0].mutedUntil).toBe(new Date(2026, 10, 2, 23, 59, 59, 999).toISOString());
  });

  it('id 列表为空 → 空数组', () => {
    expect(planBatchMute([], '3d', NOW)).toEqual([]);
  });
});

describe('muteLabelOf / silenceListToMarkdown', () => {
  it('角标文案「静音到 M/D」，脏值给空串', () => {
    expect(muteLabelOf(new Date(2026, 10, 5, 23, 59, 59, 999).toISOString())).toBe('静音到 11/05');
    expect(muteLabelOf(null)).toBe('');
    expect(muteLabelOf('')).toBe('');
    expect(muteLabelOf('不是时间')).toBe('');
  });

  it('★ Markdown 行数 = 传入行数（导出条数必须与当前筛选结果相等）', () => {
    const db = makeDB([silentApp('a1', 25, { channel: 'referral' }), silentApp('a2', 20)]);
    const rows = silenceRowsOf(db, NOW);
    const markdown = silenceListToMarkdown(rows);
    const lines = markdown.split('\n');
    // 表头 + 分隔线 + 每行一条
    expect(lines).toHaveLength(rows.length + 2);
    expect(lines[0]).toBe('| 公司 | 岗位 | 沉默天数 | 渠道 | 状态 | 建议动作 |');
    expect(lines[2]).toContain('| 字节 | 岗位 a1 | 25 |');
    expect(lines[2]).toContain('内推');
  });

  it('公司缺失时写「未知公司」，渠道缺失写「—」', () => {
    const db = makeDB([silentApp('a1', 25, { companyId: 'c-missing' })]);
    const markdown = silenceListToMarkdown(silenceRowsOf(db, NOW));
    expect(markdown).toContain('| 未知公司 |');
    expect(markdown).toContain('| — |');
  });
});

/* ==================== v1.0.0 · SIL-1 的计数不变式（QA 补：全库守恒） ==================== */

import { isMuted, silenceStateOf } from '../rules';

describe('SIL-1 · 两组条数之和 = 全库「level !== null」的投递数', () => {
  /** 造一个覆盖全部边界的小库：红 / 黄 / 静音 / 终态 / 想投 / 已删除 / 回收站 */
  function mixedDB(): DB {
    return makeDB([
      silentApp('red-20', 20), // 红（≥7）
      silentApp('red-15', 15),
      silentApp('yellow-5', 5), // 黄（3~6）
      silentApp('yellow-3', 3),
      silentApp('fresh-1', 1), // level = null
      silentApp('referral-10', 10, { channel: 'referral' }), // 内推 ×3 ⇒ 黄（21 天才红）
      silentApp('muted-red', 30, { mutedUntil: mutedFor3Days() }), // 静音但仍在红组
      silentApp('rejected-30', 30, { status: 'rejected' }), // 终态：level === null
      silentApp('wishlist-40', 40, { status: 'wishlist' }), // 想投：level === null
      silentApp('deleted-40', 40, { deletedAt: '2026-10-20T00:00:00.000Z' }), // 回收站：不计
    ]);
  }

  it('★ hideMuted=false：total 恒等于全库 level !== null 的未删除投递数（含静音条目）', () => {
    const db = mixedDB();
    const expected = db.applications.filter(
      (app) => !app.deletedAt && silenceStateOf(app, db.notes, db.settings, NOW).level !== null,
    ).length;

    const rows = silenceRowsOf(db, NOW);
    const groups = buildSilenceGroups(rows, { hideMuted: false });
    expect(groups.total).toBe(expected);
    expect(groups.stale.length + groups.warn.length).toBe(expected);
    // 静音条目不单独成组：它就在 stale 里
    expect(groups.stale.some((row) => row.app.id === 'muted-red')).toBe(true);
  });

  it('★ hideMuted=true：只减掉静音条目，mutedTotal 如实报出「藏了几条」', () => {
    const db = mixedDB();
    const rows = silenceRowsOf(db, NOW);
    const all = buildSilenceGroups(rows, { hideMuted: false });
    const hidden = buildSilenceGroups(rows, { hideMuted: true });
    const mutedCount = rows.filter((row) => isMuted(row.app, NOW)).length;

    expect(mutedCount).toBeGreaterThan(0);
    expect(hidden.total).toBe(all.total - mutedCount);
    expect(hidden.mutedTotal).toBe(all.mutedTotal);
    // 数字自洽：隐藏后的条数 + 静音条数 = 全库守恒值
    expect(hidden.total + hidden.mutedTotal).toBe(all.total);
  });

  it('★ 归组只看 level：内推 10 天在黄组，在同一份数据里 20 天的 BOSS 在红组', () => {
    const db = mixedDB();
    const rows = silenceRowsOf(db, NOW);
    const groups = buildSilenceGroups(rows, { hideMuted: false });
    expect(groups.warn.map((row) => row.app.id)).toContain('referral-10');
    expect(groups.stale.map((row) => row.app.id)).not.toContain('referral-10');
    expect(groups.stale.map((row) => row.app.id)).toContain('red-20');
  });
});
