/**
 * 规则层 v0.3 新增能力的回归测试：截止派生 / 静音 / Offer 沉默 / 行动预算。
 *
 * 为什么这一层必须有测试：
 * 这四条规则是「今日该干什么」的全部依据，任何一条算错，用户看到的都不是噪音而是
 * **错误的行动建议**。尤其两处容易写错且难以肉眼发现：
 * 1. `deadlineAt` 的三态（undefined 继承 / null 关闭 / 值覆盖）—— 一旦把 undefined 读成 null，
 *    所有没设截止的投递会永远不再提醒；
 * 2. 静音与硬截止的边界 —— 静音压掉算法推断，但压不掉外部世界的期限。
 */

import { describe, expect, it } from 'vitest';
import type { Application, DB, Note, Status } from '../types';
import { defaultSettings, emptyDB } from './defaults';
import {
  buildActionItems,
  buildDailyPlan,
  buildTodos,
  deadlineStateOf,
  effectiveStaleDays,
  isMuted,
  muteRemainDays,
  SILENCE_STATUSES,
  silenceStateOf,
  type ActionItem,
} from './rules';

/** 固定「现在」：2026-10-20 10:00 本地。所有断言都相对这个时刻，避免测试随时间漂移 */
const NOW = new Date(2026, 9, 20, 10, 0, 0);

function makeApp(overrides: Partial<Application> = {}): Application {
  return {
    id: overrides.id ?? 'app-1',
    companyId: overrides.companyId ?? 'c-1',
    jobTitle: overrides.jobTitle ?? '前端实习',
    status: overrides.status ?? 'applied',
    statusChangedAt: overrides.statusChangedAt ?? '2026-10-20T01:00:00.000Z',
    lastActivityAt: overrides.lastActivityAt ?? '2026-10-20T01:00:00.000Z',
    createdAt: overrides.createdAt ?? '2026-10-20T01:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-10-20T01:00:00.000Z',
    ...overrides,
  };
}

function makeDB(apps: Application[], notes: Note[] = []): DB {
  const db = emptyDB();
  db.companies = [{ id: 'c-1', name: '某某科技', createdAt: '2026-10-01T00:00:00.000Z' }];
  db.applications = apps;
  db.notes = notes;
  return db;
}

/** 造一条「N 天前有互动」的状态变成基准，用来精确控制沉默天数 */
function appSilentFor(days: number, overrides: Partial<Application> = {}): Application {
  const at = new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
  return makeApp({ statusChangedAt: at.toISOString(), lastActivityAt: at.toISOString(), ...overrides });
}

describe('SILENCE_STATUSES', () => {
  it('必须覆盖 offer —— 拖着不签才是最贵的沉默', () => {
    expect(SILENCE_STATUSES).toContain('offer');
  });

  it('终态不参与沉默计算', () => {
    for (const status of ['onboarded', 'rejected', 'dropped'] as Status[]) {
      expect(SILENCE_STATUSES).not.toContain(status);
    }
  });
});

describe('effectiveStaleDays：offer 不乘渠道系数', () => {
  it('内推的普通投递按 ×3 放大', () => {
    const settings = defaultSettings();
    const app = makeApp({ channel: 'referral', status: 'applied' });
    expect(effectiveStaleDays(app, settings)).toBe(settings.staleAfterDays * 3);
  });

  it('内推的 offer 仍按 offerSilenceDays 原值', () => {
    const settings = defaultSettings();
    const app = makeApp({ channel: 'referral', status: 'offer' });
    expect(effectiveStaleDays(app, settings)).toBe(settings.offerSilenceDays);
  });

  it('silenceOverride 对 offer 依然优先（用户显式设过就听用户的）', () => {
    const settings = defaultSettings();
    const app = makeApp({ status: 'offer', silenceOverride: 2 });
    expect(effectiveStaleDays(app, settings)).toBe(2);
  });
});

describe('silenceStateOf：offer 的文案要说清「在等什么」', () => {
  it('超过 offerSilenceDays 判 stale，文案是「等 Offer 回复」', () => {
    const settings = defaultSettings();
    const app = appSilentFor(settings.offerSilenceDays + 1, { status: 'offer' });
    const state = silenceStateOf(app, [], settings, NOW);
    expect(state.level).toBe('stale');
    expect(state.text).toContain('等 Offer 回复');
  });

  it('刚拿到 offer 不算沉默', () => {
    const settings = defaultSettings();
    const app = appSilentFor(1, { status: 'offer' });
    expect(silenceStateOf(app, [], settings, NOW).level).toBeNull();
  });
});

describe('deadlineStateOf：三态与分级', () => {
  const settings = defaultSettings(); // deadlineWarnDays = 3

  it('undefined / null 都不提醒（当前版本行为一致，语义留待 Season 接入）', () => {
    expect(deadlineStateOf(makeApp(), settings, NOW).level).toBeNull();
    expect(deadlineStateOf(makeApp({ deadlineAt: null }), settings, NOW).level).toBeNull();
  });

  it('今天截止 → today', () => {
    const state = deadlineStateOf(makeApp({ deadlineAt: '2026-10-20' }), settings, NOW);
    expect(state.level).toBe('today');
    expect(state.days).toBe(0);
    expect(state.text).toBe('今天截止');
  });

  it('已过 3 天 → overdue，days 为负', () => {
    const state = deadlineStateOf(makeApp({ deadlineAt: '2026-10-17' }), settings, NOW);
    expect(state.level).toBe('overdue');
    expect(state.days).toBe(-3);
    expect(state.text).toContain('3 天');
  });

  it('明天 / 3 天后都在预警窗口内', () => {
    expect(deadlineStateOf(makeApp({ deadlineAt: '2026-10-21' }), settings, NOW).level).toBe('soon');
    expect(deadlineStateOf(makeApp({ deadlineAt: '2026-10-23' }), settings, NOW).level).toBe('soon');
  });

  it('超出预警窗口不提醒，但 days 仍然可用（列表页要显示「N 天后截止」）', () => {
    const state = deadlineStateOf(makeApp({ deadlineAt: '2026-10-31' }), settings, NOW);
    expect(state.level).toBeNull();
    expect(state.days).toBe(11);
  });

  it('终态一律不提醒（人已经入职/已挂/已放弃，再提醒只是噪音）', () => {
    for (const status of ['onboarded', 'rejected', 'dropped'] as Status[]) {
      const state = deadlineStateOf(makeApp({ status, deadlineAt: '2026-10-01' }), settings, NOW);
      expect(state.level).toBeNull();
    }
  });

  it('脏日期被忽略而不是算成「今天」', () => {
    expect(deadlineStateOf(makeApp({ deadlineAt: '不是日期' }), settings, NOW).level).toBeNull();
  });
});

describe('isMuted / muteRemainDays', () => {
  const laterIso = new Date(2026, 9, 25, 12, 0, 0).toISOString();

  it('未来时间 → 静音中，剩余天数按自然日算', () => {
    const app = makeApp({ mutedUntil: laterIso });
    expect(isMuted(app, NOW)).toBe(true);
    expect(muteRemainDays(app, NOW)).toBe(5);
  });

  it('已过期 / 未设置 / 脏值 → 未静音', () => {
    expect(isMuted(makeApp({ mutedUntil: new Date(2026, 9, 19).toISOString() }), NOW)).toBe(false);
    expect(isMuted(makeApp(), NOW)).toBe(false);
    expect(isMuted(makeApp({ mutedUntil: 'xx' }), NOW)).toBe(false);
  });

  it('过期后剩余天数为 null（不是 0，避免 UI 显示「还剩 0 天」）', () => {
    const app = makeApp({ mutedUntil: new Date(2026, 9, 19).toISOString() });
    expect(muteRemainDays(app, NOW)).toBeNull();
  });
});

describe('buildTodos：静音与截止的关系', () => {
  it('静音的应用不进沉默待办', () => {
    const settings = defaultSettings();
    const app = appSilentFor(settings.staleAfterDays + 5, {
      mutedUntil: new Date(2026, 9, 25).toISOString(),
    });
    const todos = buildTodos(makeDB([app]), NOW);
    expect(todos.stale).toHaveLength(0);
  });

  it('★ 静音压不住硬截止：同一家静音中，截止仍然进待办', () => {
    const settings = defaultSettings();
    const app = appSilentFor(settings.staleAfterDays + 5, {
      deadlineAt: '2026-10-20',
      mutedUntil: new Date(2026, 9, 25).toISOString(),
    });
    const todos = buildTodos(makeDB([app]), NOW);
    expect(todos.stale).toHaveLength(0);
    expect(todos.deadline).toHaveLength(1);
    expect(todos.deadline[0].state.level).toBe('today');
  });

  it('截止按紧急度降序：overdue 排在 soon 前', () => {
    const overdue = makeApp({ id: 'a', deadlineAt: '2026-10-15' });
    const soon = makeApp({ id: 'b', deadlineAt: '2026-10-22' });
    const todos = buildTodos(makeDB([soon, overdue]), NOW);
    expect(todos.deadline.map((item) => item.app.id)).toEqual(['a', 'b']);
  });

  it('未进预警窗口的截止不进待办（不能天天提醒两个月后的截止）', () => {
    const app = makeApp({ deadlineAt: '2026-12-31' });
    expect(buildTodos(makeDB([app]), NOW).deadline).toHaveLength(0);
  });
});

describe('buildActionItems：顺序即优先级（预算按此截断）', () => {
  const settings = defaultSettings();

  function kindsOf(items: ActionItem[]): string[] {
    return items.map((item) => item.kind);
  }

  it('红档：已过截止 → 沉默深处', () => {
    const overdue = appSilentFor(1, { id: 'due', deadlineAt: '2026-10-18' });
    const stale = appSilentFor(settings.staleAfterDays + 3, { id: 'stale' });
    const todos = buildTodos(makeDB([stale, overdue]), NOW);
    const items = buildActionItems(todos, makeDB([]).companies, settings, NOW);
    expect(kindsOf(items).slice(0, 2)).toEqual(['deadline', 'stale']);
  });

  it('黄档：快截止 → 该轻催 → 想投放太久', () => {
    const soon = makeApp({ id: 'soon', deadlineAt: '2026-10-22' });
    const warn = appSilentFor(settings.warnAfterDays + 1, { id: 'warn' });
    const wish = makeApp({
      id: 'wish',
      status: 'wishlist',
      createdAt: new Date(2026, 9, 1).toISOString(),
    });
    const todos = buildTodos(makeDB([wish, warn, soon]), NOW);
    const items = buildActionItems(todos, makeDB([]).companies, settings, NOW);
    expect(kindsOf(items)).toEqual(['deadline', 'warn', 'wishlist']);
  });

  it('静音的应用不出现在任何软提醒里', () => {
    const app = appSilentFor(settings.staleAfterDays + 3, {
      mutedUntil: new Date(2026, 9, 25).toISOString(),
    });
    const items = buildActionItems(buildTodos(makeDB([app]), NOW), makeDB([]).companies, settings, NOW);
    expect(items).toHaveLength(0);
  });

  it('offer 沉默的文案要点明是 Offer，不能只说「沉默」', () => {
    const app = appSilentFor(settings.offerSilenceDays + 1, { status: 'offer' });
    const items = buildActionItems(buildTodos(makeDB([app]), NOW), makeDB([]).companies, settings, NOW);
    expect(items[0].kind).toBe('stale');
    expect(items[0].detail).toContain('Offer');
  });
});

describe('buildDailyPlan：预算只砍尾巴，不重排', () => {
  const items: ActionItem[] = Array.from({ length: 7 }, (_, index) => ({
    key: `k${index}`,
    kind: 'warn' as const,
    appId: `a${index}`,
    title: `t${index}`,
    detail: '',
    tone: 'amber' as const,
    doneHint: '',
  }));

  it('条数不超过预算时全部展开，overflow 为空', () => {
    const plan = buildDailyPlan(items.slice(0, 3), 5);
    expect(plan.primary).toHaveLength(3);
    expect(plan.overflow).toHaveLength(0);
    expect(plan.total).toBe(3);
  });

  it('超出预算时前 budget 条进 primary，其余进 overflow，顺序不变', () => {
    const plan = buildDailyPlan(items, 5);
    expect(plan.primary.map((item) => item.key)).toEqual(['k0', 'k1', 'k2', 'k3', 'k4']);
    expect(plan.overflow.map((item) => item.key)).toEqual(['k5', 'k6']);
    expect(plan.total).toBe(7);
    expect(plan.budget).toBe(5);
  });

  it('budget <= 0 视为不限量（用户主动关掉折叠）', () => {
    expect(buildDailyPlan(items, 0).overflow).toHaveLength(0);
    expect(buildDailyPlan(items, -3).primary).toHaveLength(7);
  });

  it('小数预算向下取整，不会切出半条', () => {
    expect(buildDailyPlan(items, 2.9).primary).toHaveLength(2);
  });
});
