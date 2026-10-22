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
  buildNoteIndex,
  buildTodos,
  deadlineStateOf,
  effectiveStaleDays,
  isMuted,
  latestUserNoteOf,
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

/* ======================= v0.4：日程冲突（面试 × 课 × 任何事） ======================= */

import type { CalendarEvent, Interview } from '../types';
import { eventsOnDate, findConflicts, findEventConflicts } from './rules';

function makeInterview(scheduledAt: string, overrides: Partial<Interview> = {}): Interview {
  return {
    id: overrides.id ?? 'iv-1',
    applicationId: 'app-1',
    round: 1,
    scheduledAt,
    format: 'video',
    result: 'pending',
    ...overrides,
  };
}

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: overrides.id ?? 'ev-1',
    title: overrides.title ?? '导师组会',
    kind: overrides.kind ?? 'personal',
    start: overrides.start ?? '14:00',
    end: overrides.end ?? '15:30',
    weekly: overrides.weekly ?? false,
    weekday: overrides.weekly ? overrides.weekday ?? 2 : undefined,
    date: overrides.weekly ? undefined : overrides.date ?? '2026-10-20',
  };
}

describe('findConflicts：面试与日程冲突', () => {
  // 2026-10-20 是周二（weekday 2），14:30 开始 60 分钟
  const iv = makeInterview('2026-10-20T14:30:00');

  it('与同一天的日程时间段重叠 → 报冲突', () => {
    const messages = findConflicts(iv, [], [], [makeEvent({ start: '14:00', end: '15:30' })]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('导师组会');
    expect(messages[0]).toContain('14:00-15:30');
  });

  it('同一天但不重叠（错开 30 分钟）→ 不报', () => {
    const messages = findConflicts(iv, [], [], [makeEvent({ start: '12:00', end: '13:30' })]);
    expect(messages).toHaveLength(0);
  });

  it('边界：日程 15:30 结束、面试 14:30 开始且持续到 15:30 → 不算重叠', () => {
    // 面试 14:30 + 60min = 15:30；日程 15:30-16:30，端点相接不算冲突
    const messages = findConflicts(iv, [], [], [makeEvent({ start: '15:30', end: '16:30' })]);
    expect(messages).toHaveLength(0);
  });

  it('每周固定课：只有周几对上才算', () => {
    const course = makeEvent({ kind: 'course', title: '计算机网络', weekly: true, weekday: 2, start: '14:00', end: '15:40' });
    expect(findConflicts(iv, [], [], [course])).toHaveLength(1);
    // 同样的课挪到周三，与周二的面试无关
    const otherDay = makeEvent({ kind: 'course', title: '计算机网络', weekly: true, weekday: 3, start: '14:00', end: '15:40' });
    expect(findConflicts(iv, [], [], [otherDay])).toHaveLength(0);
  });

  it('与其他面试的冲突依然生效（老语义不回归）', () => {
    const other = makeInterview('2026-10-20T15:00:00', { id: 'iv-2' });
    const messages = findConflicts(iv, [other], [], []);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('另一场面试');
  });
});

describe('findEventConflicts：日程的冲突也要报', () => {
  const event = makeEvent({ start: '14:00', end: '15:30', date: '2026-10-20' });

  it('与同一天的面试重叠 → 报冲突', () => {
    const iv = makeInterview('2026-10-20T14:30:00');
    const messages = findEventConflicts(event, [event], [iv], []);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('面试');
  });

  it('与另一条日程重叠 → 报冲突（急事撞急事也算）', () => {
    const other = makeEvent({ id: 'ev-2', title: '体检', start: '15:00', end: '16:00', date: '2026-10-20' });
    const messages = findEventConflicts(event, [event, other], [], []);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('体检');
  });

  it('不同日期的同名日程不算冲突', () => {
    const other = makeEvent({ id: 'ev-2', title: '体检', start: '14:00', end: '15:30', date: '2026-10-21' });
    expect(findEventConflicts(event, [event, other], [], [])).toHaveLength(0);
  });
});

describe('eventsOnDate', () => {
  const events: CalendarEvent[] = [
    makeEvent({ id: 'ev-fixed', title: '课', kind: 'course', weekly: true, weekday: 2, start: '08:00', end: '09:40' }),
    makeEvent({ id: 'ev-tue', title: '周二的事', date: '2026-10-20' }),
    makeEvent({ id: 'ev-wed', title: '周三的事', date: '2026-10-21' }),
  ];

  it('2026-10-20（周二）：命中年二的周课 + 当天的事，不含周三', () => {
    const tuesday = new Date(2026, 9, 20);
    const ids = eventsOnDate(events, tuesday).map((e) => e.id);
    expect(ids).toEqual(['ev-fixed', 'ev-tue']);
  });

  it('2026-10-27（也是周二）：周课复现，单日的事不跟', () => {
    const nextTuesday = new Date(2026, 9, 27);
    const ids = eventsOnDate(events, nextTuesday).map((e) => e.id);
    expect(ids).toEqual(['ev-fixed']);
  });
});

/* ======================= v0.4.1：删除投递的撤销 ======================= */

import { buildSampleDB } from './sample';
import { restoreDeletedApplication } from './rules';
import type { DeletedApplication } from './rules';

describe('restoreDeletedApplication：删错了能原样放回', () => {
  const makeDeleted = (): { before: ReturnType<typeof buildSampleDB>; after: ReturnType<typeof buildSampleDB>; deleted: DeletedApplication } => {
    const before = buildSampleDB(new Date('2026-10-21T09:00:00'));
    const app = before.applications[0];
    const deleted: DeletedApplication = {
      app,
      interviews: before.interviews.filter((item) => item.applicationId === app.id),
      notes: before.notes.filter((item) => item.applicationId === app.id),
      experienceIds: before.experiences
        .filter((item) => item.applicationId === app.id)
        .map((item) => item.id),
    };
    // 复刻 deleteApplication 的删除动作
    const after = structuredClone(before);
    after.applications = after.applications.filter((item) => item.id !== app.id);
    after.interviews = after.interviews.filter((item) => item.applicationId !== app.id);
    after.notes = after.notes.filter((item) => item.applicationId !== app.id);
    after.experiences = after.experiences.map((item) =>
      item.applicationId === app.id ? { ...item, applicationId: null } : item,
    );
    return { before, after, deleted };
  };

  it('投递 / 面试 / 时间线数量全部回到删除前', () => {
    const { before, after, deleted } = makeDeleted();
    restoreDeletedApplication(after, deleted);
    expect(after.applications).toHaveLength(before.applications.length);
    expect(after.interviews).toHaveLength(before.interviews.length);
    expect(after.notes).toHaveLength(before.notes.length);
    expect(after.applications.some((item) => item.id === deleted.app.id)).toBe(true);
  });

  it('被解绑的面经重新接回这条投递', () => {
    const { after, deleted } = makeDeleted();
    restoreDeletedApplication(after, deleted);
    for (const id of deleted.experienceIds) {
      expect(after.experiences.find((item) => item.id === id)?.applicationId).toBe(deleted.app.id);
    }
  });

  it('重复恢复是幂等的（连按两次撤销不会出现两条一样的投递）', () => {
    const { after, deleted } = makeDeleted();
    restoreDeletedApplication(after, deleted);
    const countOnce = after.applications.length;
    restoreDeletedApplication(after, deleted);
    expect(after.applications).toHaveLength(countOnce);
  });

  it('面经在删除后被用户改绑到别的投递 → 恢复时不抢回来', () => {
    const { after, deleted } = makeDeleted();
    const id = deleted.experienceIds[0];
    if (!id) return;
    const exp = after.experiences.find((item) => item.id === id);
    if (!exp) return;
    exp.applicationId = 'another-app';
    restoreDeletedApplication(after, deleted);
    expect(after.experiences.find((item) => item.id === id)?.applicationId).toBe('another-app');
  });
});

/* ======================= v0.5 · 卡片预览：最新一条人写的记录 ======================= */

describe('latestUserNoteOf', () => {
  const note = (id: string, over: Partial<Note>): Note => ({
    id,
    applicationId: 'a1',
    type: 'memo',
    content: '内容',
    touchedAt: '2026-10-20T08:00:00.000Z',
    ...over,
  });

  it('桶为空时返回 null', () => {
    expect(latestUserNoteOf(buildNoteIndex([]), 'a1')).toBeNull();
    expect(latestUserNoteOf(buildNoteIndex([]), '不存在')).toBeNull();
  });

  it('返回最新的一条（桶内按时间倒序）', () => {
    const index = buildNoteIndex([
      note('old', { content: '旧的', touchedAt: '2026-10-19T08:00:00.000Z' }),
      note('new', { content: '最新的', touchedAt: '2026-10-20T09:00:00.000Z' }),
    ]);
    expect(latestUserNoteOf(index, 'a1')?.id).toBe('new');
  });

  it('auto 流水不占预览位：最新一条是同步写的 → 跳过它取人写的', () => {
    const index = buildNoteIndex([
      note('auto1', { auto: true, content: 'BOSS 上变为已读', touchedAt: '2026-10-20T09:00:00.000Z' }),
      note('mine', { content: 'HR 说下周一面', touchedAt: '2026-10-20T08:00:00.000Z' }),
    ]);
    const latest = latestUserNoteOf(index, 'a1');
    expect(latest?.id).toBe('mine');
    expect(latest?.content).toBe('HR 说下周一面');
  });

  it('全是 auto 时返回 null（宁可不显示，也不拿系统流水冒充用户记的）', () => {
    const index = buildNoteIndex([
      note('s1', { auto: true, touchedAt: '2026-10-20T09:00:00.000Z' }),
      note('s2', { auto: true, touchedAt: '2026-10-19T09:00:00.000Z' }),
    ]);
    expect(latestUserNoteOf(index, 'a1')).toBeNull();
  });

  it('不同投递互不串：a2 的记录不会出现在 a1 的卡片上', () => {
    const index = buildNoteIndex([
      note('x', { applicationId: 'a2', content: '别人的' }),
    ]);
    expect(latestUserNoteOf(index, 'a1')).toBeNull();
    expect(latestUserNoteOf(index, 'a2')?.id).toBe('x');
  });
});

/* ======================= v0.8：笔试（written）进规则层 ======================= */

import {
  BOARD_COLUMNS,
  REJECT_ROUND_OPTIONS,
  STATUS_LABEL,
  STATUS_TONE,
  currentRoundOf,
  interviewKindLabel,
  rejectedRoundLabel,
  rejectedRoundShort,
  revertStatusChange,
  roundBadgeText,
  stageRankOf,
  suggestionFor,
} from './rules';

function makeInterviewAt(overrides: Partial<Interview> = {}): Interview {
  return {
    id: overrides.id ?? 'iv-1',
    applicationId: overrides.applicationId ?? 'app-1',
    round: overrides.round ?? 1,
    scheduledAt: overrides.scheduledAt ?? '2026-10-18T10:00:00.000Z',
    format: overrides.format ?? 'video',
    kind: overrides.kind,
    result: overrides.result ?? 'pending',
    ...overrides,
  };
}

describe('v0.8 · written 进五张常量表', () => {
  it('STATUS_LABEL / STATUS_TONE 都有 written 档', () => {
    expect(STATUS_LABEL.written).toBe('已笔试');
    expect(typeof STATUS_TONE.written).toBe('string');
    expect(STATUS_TONE.written).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('BOARD_COLUMNS：7 列，written 插在 chatting 与 scheduled 之间', () => {
    expect(BOARD_COLUMNS).toHaveLength(7);
    expect(BOARD_COLUMNS.indexOf('written')).toBe(BOARD_COLUMNS.indexOf('chatting') + 1);
    expect(BOARD_COLUMNS.indexOf('scheduled')).toBe(BOARD_COLUMNS.indexOf('written') + 1);
  });

  it('SILENCE_STATUSES 含 written；终态仍然不参与', () => {
    expect(SILENCE_STATUSES).toContain('written');
    for (const status of ['onboarded', 'rejected', 'dropped'] as Status[]) {
      expect(SILENCE_STATUSES).not.toContain(status);
    }
  });

  it('written 参与沉默计算，文案点明「等笔试结果」', () => {
    const settings = defaultSettings();
    const app = appSilentFor(settings.staleAfterDays + 1, { status: 'written' });
    const state = silenceStateOf(app, [], settings, NOW);
    expect(state.level).toBe('stale');
    expect(state.text).toContain('等笔试结果');
  });
});

describe('v0.8 · stageRankOf 与漏斗口径', () => {
  it('stageRankOf(written) = 2.5（落在 chatting 2 与 scheduled 3 之间）', () => {
    const app = makeApp({ status: 'written' });
    expect(stageRankOf(app, [])).toBe(2.5);
    expect(stageRankOf(makeApp({ status: 'chatting' }), [])).toBeLessThan(2.5);
    expect(stageRankOf(makeApp({ status: 'scheduled' }), [])).toBeGreaterThan(2.5);
  });

  it('★ 漏斗显示零改动：written 计入「已沟通后」不计入「已约面」', () => {
    const db = emptyDB();
    db.companies = [{ id: 'c-1', name: '某某科技', createdAt: '2026-10-01T00:00:00.000Z' }];
    db.applications = [makeApp({ status: 'written' })];
    const funnel = (() => {
      // 直接内联 buildFunnel 的口径断言（避免为了一个断言 import 整个漏斗模块）：
      // rank >= 2（已沟通后）应含 written；rank >= 3（已约面）不应含 written
      const rank = stageRankOf(db.applications[0], db.interviews);
      return { inChatting: rank >= 2, inScheduled: rank >= 3 };
    })();
    expect(funnel.inChatting).toBe(true);
    expect(funnel.inScheduled).toBe(false);
  });
});

describe('v0.8 · 挂点扩展（笔试挂 = 0）', () => {
  it('REJECT_ROUND_OPTIONS 含 {value:0, label:"笔试"}', () => {
    expect(REJECT_ROUND_OPTIONS).toContainEqual({ value: 0, label: '笔试' });
  });

  it('rejectedRoundLabel / Short：0 → 笔试（修掉旧版 round<=0 → 轮次未记）', () => {
    expect(rejectedRoundLabel(0)).toBe('笔试');
    expect(rejectedRoundShort(0)).toBe('笔试');
    // 既有语义不回归
    expect(rejectedRoundLabel(4)).toBe('第 4 轮（HR 面）');
    expect(rejectedRoundShort(4)).toBe('HR 面');
    expect(rejectedRoundLabel(2)).toBe('第 2 轮');
    expect(rejectedRoundLabel(null)).toBe('轮次未记');
    expect(rejectedRoundShort(undefined)).toBe('轮次未记');
  });

  it('负数 / 脏值仍然「轮次未记」（0 的语义不被泛化）', () => {
    expect(rejectedRoundLabel(-1)).toBe('轮次未记');
    expect(rejectedRoundShort(-1)).toBe('轮次未记');
  });
});

describe('v0.8 · 轮次徽章数据源（currentRoundOf）与面试类型', () => {
  it('取 result=pending 的最新一场（按时间正序的最后一个 pending）', () => {
    const app = makeApp({ id: 'app-1' });
    const interviews = [
      makeInterviewAt({ id: 'iv1', round: 1, result: 'passed', scheduledAt: '2026-10-10T10:00:00.000Z' }),
      makeInterviewAt({ id: 'iv2', round: 2, kind: 'hr', scheduledAt: '2026-10-22T10:00:00.000Z' }),
    ];
    expect(currentRoundOf(app, interviews)?.id).toBe('iv2');
  });

  it('全是已记结果的 → null（显示状态本名）', () => {
    const app = makeApp({ id: 'app-1' });
    const interviews = [makeInterviewAt({ id: 'iv1', result: 'passed' })];
    expect(currentRoundOf(app, interviews)).toBeNull();
  });

  it('interviewKindLabel：7 值全有中文，未标注返回空串', () => {
    expect(interviewKindLabel('written')).toBe('笔试');
    expect(interviewKindLabel('tech')).toBe('技术面');
    expect(interviewKindLabel('hr')).toBe('HR 面');
    expect(interviewKindLabel('cross')).toBe('交叉面');
    expect(interviewKindLabel('group')).toBe('群面');
    expect(interviewKindLabel('director')).toBe('总监面');
    expect(interviewKindLabel('other')).toBe('其他');
    expect(interviewKindLabel(undefined)).toBe('');
  });
});

describe('v0.8 · suggestionFor written 档', () => {
  it('笔试阶段的建议动作指向「记笔试安排」', () => {
    const app = makeApp({ status: 'written' });
    const suggestion = suggestionFor(app, { days: 0, level: null, text: '' });
    expect(suggestion.kind).toBe('schedule');
    expect(suggestion.label).toContain('笔试');
  });
});

describe('v0.8 · roundBadgeText（徽章口径）', () => {
  it('第 2 轮 · HR 面 / 纯轮次 / 笔试 / 无轮次空串', () => {
    expect(roundBadgeText(makeInterviewAt({ round: 2, kind: 'hr' }))).toBe('第 2 轮 · HR 面');
    expect(roundBadgeText(makeInterviewAt({ round: 3 }))).toBe('第 3 轮');
    expect(roundBadgeText(makeInterviewAt({ round: 0, kind: 'written' }))).toBe('笔试');
    expect(roundBadgeText(null)).toBe('');
  });
});

describe('v0.8 · written 状态变更可整体撤销（⌘Z 数据层语义）', () => {
  it('★ revertStatusChange 把 written 恢复成之前的状态，且只删本次那条系统记录', () => {
    const db = emptyDB();
    db.companies = [{ id: 'c-1', name: '某某科技', createdAt: '2026-10-01T00:00:00.000Z' }];
    db.applications = [
      makeApp({ id: 'app-1', status: 'written', statusChangedAt: '2026-10-20T01:00:00.000Z' }),
    ];
    db.notes = [
      {
        id: 'n-system',
        applicationId: 'app-1',
        type: 'system',
        content: '状态：已沟通 → 已笔试',
        auto: true,
        touchedAt: '2026-10-20T01:00:00.000Z',
      },
      {
        id: 'n-mine',
        applicationId: 'app-1',
        type: 'memo',
        content: '用户后来手写的备注',
        touchedAt: '2026-10-20T02:00:00.000Z',
      },
    ];
    const draft = structuredClone(db);
    revertStatusChange(draft, {
      appId: 'app-1',
      prevStatus: 'chatting',
      prevStatusChangedAt: '2026-10-19T01:00:00.000Z',
      prevLastActivityAt: '2026-10-19T01:00:00.000Z',
      prevRejectedAtRound: null,
      createdNoteId: 'n-system',
    });
    expect(draft.applications[0].status).toBe('chatting');
    expect(draft.applications[0].statusChangedAt).toBe('2026-10-19T01:00:00.000Z');
    // 只删系统记录；用户手写内容不丢（共享知识 #7）
    expect(draft.notes.map((note) => note.id)).toEqual(['n-mine']);
  });
});

/* ============ v0.9：简历版本面试率（id 优先 + 旧文本归一个桶，单次 O(N)） ============ */

import type { ResumeVersion } from '../types';
import {
  aggregateByVersion,
  buildResumeStats,
  DELETED_RESUME_VERSION_LABEL,
  RESUME_SAMPLE_MIN,
  UNBOUND_LEGACY_LABEL,
  UNLABELED_RESUME_LABEL,
} from './rules';

function makeVersion(id: string, label: string, overrides: Partial<ResumeVersion> = {}): ResumeVersion {
  return {
    id,
    resumeId: 'r-1',
    label,
    templateId: 'tech-single',
    content: { sections: [] },
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

/** 造一个只关心「投递 → 版本 → 面试」三张表的库 */
function resumeDB(apps: Application[], versions: ResumeVersion[], interviews: Interview[] = []): DB {
  const db = makeDB(apps);
  db.resumeVersions = versions;
  db.interviews = interviews;
  return db;
}

function interviewed(appId: string, id = `iv-${appId}`): Interview {
  return makeInterviewAt({ id, applicationId: appId });
}

describe('v0.9 · aggregateByVersion：按版本 id 聚合', () => {
  it('★ 绑了同一个版本 id 的投递聚成一行，进面数按面试表算', () => {
    const db = resumeDB(
      [
        makeApp({ id: 'a1', resumeVersionId: 'v1', resumeVersion: 'v1 前端' }),
        makeApp({ id: 'a2', resumeVersionId: 'v1', resumeVersion: 'v1 前端' }),
        makeApp({ id: 'a3', resumeVersionId: 'v1' }),
      ],
      [makeVersion('v1', 'v1 前端')],
      [interviewed('a1'), interviewed('a3')],
    );
    const rows = aggregateByVersion(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ versionId: 'v1', label: 'v1 前端', total: 3, interviewed: 2 });
  });

  it('★ 版本改名不漂移：label 跟版本表走，不看投递上的旧快照', () => {
    const db = resumeDB(
      [makeApp({ id: 'a1', resumeVersionId: 'v1', resumeVersion: '旧名（改名前）' })],
      [makeVersion('v1', '新名（改名后）')],
    );
    const rows = aggregateByVersion(db);
    expect(rows[0].label).toBe('新名（改名后）');
    expect(rows[0].versionId).toBe('v1');
  });

  it('版本已被真删：用投递上的快照名兜底；连快照都没有才用「（已删除的版本）」', () => {
    const db = resumeDB(
      [
        makeApp({ id: 'a1', resumeVersionId: 'gone', resumeVersion: '快照名' }),
        makeApp({ id: 'a2', resumeVersionId: 'gone-2' }),
      ],
      [],
    );
    const byId = new Map(aggregateByVersion(db).map((row) => [row.versionId, row.label]));
    expect(byId.get('gone')).toBe('快照名');
    expect(byId.get('gone-2')).toBe(DELETED_RESUME_VERSION_LABEL);
  });

  it('★ 老数据（只有文本、没有 id）不论文本几种都归「未绑定（旧数据）」一个桶', () => {
    const db = resumeDB(
      [
        makeApp({ id: 'a1', resumeVersion: '前端-项目版' }),
        makeApp({ id: 'a2', resumeVersion: '前端-算法版' }),
        makeApp({ id: 'a3', resumeVersion: '前端-项目版' }),
      ],
      [],
    );
    const rows = aggregateByVersion(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].versionId).toBeNull();
    expect(rows[0].label).toBe(UNBOUND_LEGACY_LABEL);
    expect(rows[0].total).toBe(3);
  });

  it('什么都没标 → 「未标注」桶；空文本等于没标', () => {
    const db = resumeDB([makeApp({ id: 'a1' }), makeApp({ id: 'a2', resumeVersion: '' })], []);
    const rows = aggregateByVersion(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe(UNLABELED_RESUME_LABEL);
    expect(rows[0].total).toBe(2);
  });

  it('三种桶可以共存，并按投递数降序排（同数按名排）', () => {
    const db = resumeDB(
      [
        makeApp({ id: 'a1', resumeVersionId: 'v1' }),
        makeApp({ id: 'a2', resumeVersionId: 'v1' }),
        makeApp({ id: 'a3', resumeVersionId: 'v1' }),
        makeApp({ id: 'a4', resumeVersion: '旧文本' }),
        makeApp({ id: 'a5', resumeVersion: '旧文本 2' }),
        makeApp({ id: 'a6' }),
      ],
      [makeVersion('v1', 'v1 前端')],
    );
    expect(aggregateByVersion(db).map((row) => [row.label, row.total])).toEqual([
      ['v1 前端', 3],
      [UNBOUND_LEGACY_LABEL, 2],
      [UNLABELED_RESUME_LABEL, 1],
    ]);
  });

  it('★ 两个版本可以同名：两行都在，靠 versionId 区分（视图的 key 用它）', () => {
    const db = resumeDB(
      [
        makeApp({ id: 'a1', resumeVersionId: 'v1' }),
        makeApp({ id: 'a2', resumeVersionId: 'v2' }),
      ],
      [makeVersion('v1', '前端版'), makeVersion('v2', '前端版')],
    );
    const stats = buildResumeStats(db);
    expect(stats).toHaveLength(2);
    expect(stats.map((row) => row.label)).toEqual(['前端版', '前端版']);
    // 文案撞了，id 没撞 —— 复盘页的 key 用 versionId ?? label
    expect(new Set(stats.map((row) => row.versionId ?? row.label)).size).toBe(2);
  });

  it('空库 → 空数组（不造出空桶）', () => {
    expect(aggregateByVersion(resumeDB([], []))).toEqual([]);
  });
});

describe('v0.9 · buildResumeStats：老文本数据仍出结果（复盘页不回退）', () => {
  it('★ v0.8 形态的数据（只有 resumeVersion 文本）照旧算出面试率', () => {
    const db = resumeDB(
      [
        makeApp({ id: 'a1', resumeVersion: '前端简历' }),
        makeApp({ id: 'a2', resumeVersion: '前端简历' }),
        makeApp({ id: 'a3', resumeVersion: '后端简历' }),
        makeApp({ id: 'a4', resumeVersion: '后端简历' }),
      ],
      [],
      [interviewed('a1'), interviewed('a3')],
    );
    const stats = buildResumeStats(db);
    expect(stats).toHaveLength(1);
    // 四份投递都只有文本 → 同一个「未绑定」桶；不会因为文本不同被拆成两行
    expect(stats[0].label).toBe(UNBOUND_LEGACY_LABEL);
    expect(stats[0].version).toBe(stats[0].label);
    expect(stats[0].total).toBe(4);
    expect(stats[0].interviewed).toBe(2);
    expect(stats[0].rate).toBeCloseTo(0.5, 10);
  });

  it('rate 是 0~1 的小数；versionId 原样带出，旧数据的 versionId 是 null', () => {
    const db = resumeDB(
      [makeApp({ id: 'a1', resumeVersionId: 'v1' }), makeApp({ id: 'a2', resumeVersion: '文本' })],
      [makeVersion('v1', 'v1')],
      [interviewed('a1')],
    );
    // 两行 total 相同 → 顺序由 label 排序决定，别按下标取值
    const stats = buildResumeStats(db);
    const bound = stats.find((row) => row.versionId === 'v1');
    const legacy = stats.find((row) => row.versionId === null);
    expect(bound?.rate).toBe(1);
    expect(legacy?.rate).toBe(0);
  });

  it('★ 样本门槛：投递满 20 份才 sampleEnough', () => {
    const few = resumeDB(
      Array.from({ length: RESUME_SAMPLE_MIN - 1 }, (_, i) =>
        makeApp({ id: `few-${i}`, resumeVersionId: 'v1' }),
      ),
      [makeVersion('v1', 'v1')],
    );
    expect(buildResumeStats(few)[0].sampleEnough).toBe(false);

    const enough = resumeDB(
      Array.from({ length: RESUME_SAMPLE_MIN }, (_, i) =>
        makeApp({ id: `ok-${i}`, resumeVersionId: 'v1' }),
      ),
      [makeVersion('v1', 'v1')],
    );
    expect(buildResumeStats(enough)[0].sampleEnough).toBe(true);
  });

  it('面试记录挂在别的投递上不算进面', () => {
    const db = resumeDB(
      [makeApp({ id: 'a1', resumeVersionId: 'v1' }), makeApp({ id: 'a2', resumeVersionId: 'v1' })],
      [makeVersion('v1', 'v1')],
      [interviewed('a1'), interviewed('a2'), interviewed('a2', 'iv-dup')],
    );
    const stat = buildResumeStats(db)[0];
    // 同一条投递有两场面试也只算一次「进面」
    expect(stat.interviewed).toBe(2);
  });
});

describe('v0.9 · aggregateByVersion：性能（验收 27）', () => {
  it('★ 500 条投递 + 30 个版本，单次聚合 < 20ms', () => {
    const versions = Array.from({ length: 30 }, (_, i) => makeVersion(`v${i}`, `版本 ${i}`));
    const apps = Array.from({ length: 500 }, (_, i) =>
      makeApp({
        id: `perf-${i}`,
        // 2/3 绑定版本、1/6 只有旧文本、1/6 什么都没标
        ...(i % 6 === 5
          ? {}
          : i % 6 === 4
            ? { resumeVersion: `旧文本 ${i % 4}` }
            : { resumeVersionId: `v${i % 30}` }),
      }),
    );
    const interviews = apps.filter((_, i) => i % 3 === 0).map((item) => interviewed(item.id));
    const db = resumeDB(apps, versions, interviews);

    // 预热一轮，避免把首次的 JIT / 结构体分配算进耗时
    aggregateByVersion(db);
    const start = performance.now();
    const rows = aggregateByVersion(db);
    const elapsed = performance.now() - start;

    expect(rows.reduce((sum, row) => sum + row.total, 0)).toBe(500);
    // 桶数按数据自己算（不写死）：每个绑定版本一个桶 + 旧文本桶 + 未标注桶
    const keys = new Set(
      apps.map((item) =>
        item.resumeVersionId ? `id:${item.resumeVersionId}` : item.resumeVersion ? 'legacy' : 'none',
      ),
    );
    expect(rows).toHaveLength(keys.size);
    expect(elapsed).toBeLessThan(20);
  });
});
