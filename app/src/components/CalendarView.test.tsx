// @vitest-environment jsdom
/**
 * CalendarView（面试日历）头部「⚠ N 条记录有冲突」的口径回归。
 *
 * 这组测试存在的唯一理由：**头部那个数字到底是什么单位**。
 * 它数的是「参与冲突的**记录条数**」（一场面试 +1、一条日程 +1），不是「撞车次数」、
 * 也不是「侧栏 ⚠ 块里的消息条数」。三个数在真实数据里各不相同：
 *
 *   - 一次物理撞车（1 面试 × 1 日程） → 头部 2、侧栏块 2、消息 2
 *   - 一次物理撞车 + 一条日程同时撞两条 → 头部 3、侧栏块 3、消息 4
 *
 * 用例 ② 是关键：只有「1 面试 × 2 日程」这种**不对称**种子才能把
 * 「数块」与「数消息」、「记录数」与「撞车次数」区分开 ——
 * 用例 ① 里块数 = 消息数 = 2，三种写法都能过，没有区分力。
 *
 * 另有两条口径被钉死：
 *   - **头部是全库口径**（db.events 全部 + db.interviews 全部，不分月份）；
 *   - **月格 ⚠ 是按天去重的当月口径**（含网格里露出来的上/下月日期）。
 *     用例 ③ 把上月的冲突放到网格覆盖不到的日子，于是头部 > 0 而当月 ⚠ = 0，
 *     后人若把任一范围改歪，这条会红。
 *
 * 种子纪律（写日历测试的人请照抄）：
 *   1. 日程一律 `weekly: false` + 显式 `date`。`rules.eventsOnDate` 对 `weekly: true`
 *      按周几匹配返回，一份周课会在每个匹配日各返回一次，侧栏块数会被放大，
 *      测试就测不到「一条日程 = 一个块」了。
 *   2. 面试的 `scheduledAt` 写**不带 Z 的本地时刻**（`2026-03-10T14:00:00`）。
 *      `rules.intervalOf` 用 `getHours()/getMinutes()` 取**本地**时分，
 *      `interviewsOnDay` 用 `toDateISO` 取**本地**自然日 —— 统一成本地语义，
 *      测试在 UTC 和东八区下都得到同一个结果，不会把时区写死进期望值。
 *   3. 重叠判定是**半开区间** `a.start < b.end && b.start < a.end`
 *      （`rules.overlap`），相邻不重叠（14:00-15:00 与 15:00-16:00 不算冲突）。
 *      面试时长缺省按 60 分钟算（`rules.durationOf`）。
 *   4. 月网格固定 42 格，2026 年 3 月那页是 2/23 – 4/5；断言「本月网格」时
 *      要排除 `.is-outside` 的格子，否则上/下月的日子会混进来。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppApi } from '../lib/api';
import { emptyDB } from '../lib/defaults';
import type { Application, CalendarEvent, DB, Interview } from '../types';
import { CalendarView } from './CalendarView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 2026-03-10（本地）—— 日历默认选中「今天」。3 月那页网格 = 2/23 – 4/5。 */
const NOW = new Date(2026, 2, 10, 10, 0, 0);
const DAY = '2026-03-10';
/** 上月且**在网格之外**（2/5 早于 2/23）：用来隔离「头部口径」与「网格口径」。 */
const PREV_DAY = '2026-02-05';

function makeEvent(id: string, start: string, end: string, date: string = DAY): CalendarEvent {
  return { id, title: `日程 ${id}`, kind: 'personal', start, end, weekly: false, date };
}

function makeInterview(id: string, scheduledAt: string, overrides: Partial<Interview> = {}): Interview {
  return {
    id,
    applicationId: 'app-1',
    round: 1,
    scheduledAt,
    durationMin: 60,
    format: 'video',
    result: 'pending',
    ...overrides,
  };
}

function makeApp(overrides: Partial<Application> = {}): Application {
  return {
    id: 'app-1',
    companyId: 'c-1',
    jobTitle: '前端实习',
    status: 'scheduled',
    statusChangedAt: '2026-03-01T01:00:00.000Z',
    lastActivityAt: '2026-03-01T01:00:00.000Z',
    createdAt: '2026-03-01T01:00:00.000Z',
    updatedAt: '2026-03-01T01:00:00.000Z',
    ...overrides,
  };
}

function makeDB(interviews: Interview[], events: CalendarEvent[]): DB {
  const db = emptyDB();
  db.companies = [{ id: 'c-1', name: '某某科技', createdAt: '2026-03-01T00:00:00.000Z' }];
  db.applications = [makeApp()];
  db.interviews = interviews;
  db.events = events;
  return db;
}

/** 只 mock CalendarView 会触碰的入口；写库通道全用 vi.fn()，被误触发时一眼看得见。 */
function makeApi(db: DB): AppApi {
  return {
    db,
    now: NOW,
    view: 'calendar',
    selectedId: null,
    highlightedId: null,
    toast: vi.fn(),
    openDetail: vi.fn(),
    addCalendarEvent: vi.fn(),
    deleteCalendarEvent: vi.fn(),
    importCourseEvents: vi.fn(),
  } as unknown as AppApi;
}

describe('CalendarView 头部冲突口径（jsdom）', () => {
  let host: HTMLDivElement;
  let root: Root | null = null;

  const render = (db: DB): void => {
    act(() => {
      root?.render(<CalendarView api={makeApi(db)} />);
    });
  };

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    host.remove();
    root = null;
  });

  /* ------------------------------ 断言辅助 ------------------------------ */

  /**
   * 头部那一行。刻意**不按类名选**：这行用的是 token 化类名（CLS.ad），
   * 拿类名断言等于把 token 表写进测试。改按文案特征找，语义稳。
   */
  const headerLine = (): HTMLElement => {
    const found = [...host.querySelectorAll<HTMLElement>('span')].find((el) =>
      (el.textContent || '').includes('场面试'),
    );
    if (!found) throw new Error('没找到头部统计行');
    return found;
  };

  /** 头部冲突数：只认「⚠ N 条记录有冲突」这一个形状，零冲突时返回 null。 */
  const headerConflictCount = (): number | null => {
    const matched = (headerLine().textContent || '').match(/⚠ (\d+) 条记录有冲突/);
    return matched ? Number(matched[1]) : null;
  };

  /** 侧栏 ⚠ 块数（一场面试一个、一条日程一个）。 */
  const sideConflictBlocks = (): number => host.querySelectorAll('.cal__item-conflict').length;

  /** 侧栏 ⚠ 块里的消息总条数（块内每条形如 <p>…</p>）。 */
  const sideConflictMessages = (): number => host.querySelectorAll('.cal__item-conflict p').length;

  /** 当天月格（排除上下月露出来的格子 —— 它们和本月不是同一口径）。 */
  const inMonthCell = (day: number): HTMLElement => {
    const found = [...host.querySelectorAll<HTMLElement>('.cal__cell')].find(
      (cell) =>
        !cell.classList.contains('is-outside') &&
        cell.querySelector('.cal__date')?.textContent === String(day),
    );
    if (!found) throw new Error(`本月网格里没有 ${day} 号`);
    return found;
  };

  /** 本月网格里 ⚠ 角标的总数。 */
  const monthWarnCount = (): number => host.querySelectorAll('.cal__cell:not(.is-outside) .cal__warn').length;

  /* -------------------------------- 用例 -------------------------------- */

  it('① 对称：1 面试 × 1 日程重叠 → 头部 2、侧栏 2 块、2 条消息、当天 1 个 ⚠', () => {
    // 面试 14:00-15:00（durationMin 60）；日程 14:30-15:30 —— 真的重叠。
    render(makeDB([makeInterview('iv-1', `${DAY}T14:00:00`)], [makeEvent('ev-1', '14:30', '15:30')]));

    expect(headerLine().textContent).toContain('1 场面试 · 1 条日程');
    expect(headerConflictCount()).toBe(2);
    expect(headerLine().textContent).not.toContain('处时间冲突');

    expect(sideConflictBlocks()).toBe(2); // 日程一个块 + 面试一个块
    expect(sideConflictMessages()).toBe(2); // 每块一条消息
    expect(inMonthCell(10).querySelectorAll('.cal__warn')).toHaveLength(1);
    expect(monthWarnCount()).toBe(1);
  });

  it('★② 不对称：1 面试 × 2 条重叠日程 → 头部 3、侧栏 3 块、4 条消息、当天仍 1 个 ⚠', () => {
    // 面试 14:00-15:00；ev-1 14:30-15:30 撞它；ev-2 13:00-14:10 也撞它。
    // 物理上只有 2 次撞车（iv×ev-1、iv×ev-2），ev-1 与 ev-2 互不重叠。
    render(
      makeDB(
        [makeInterview('iv-1', `${DAY}T14:00:00`)],
        [makeEvent('ev-1', '14:30', '15:30'), makeEvent('ev-2', '13:00', '14:10')],
      ),
    );

    // 头部 3 = 记录数（1 面试 + 2 日程），不是撞车次数 2，也不是消息数 4。
    expect(headerConflictCount()).toBe(3);

    // 侧栏 3 块（每条记录一块）—— 这一条钉死「数块不数消息」。
    expect(sideConflictBlocks()).toBe(3);
    // 消息 4 条：面试 2 条（撞两条日程）+ ev-1 一条 + ev-2 一条。
    expect(sideConflictMessages()).toBe(4);
    expect(host.querySelectorAll('.cal__event-item')).toHaveLength(2);

    // 月格仍是「这天有没有冲突」的布尔，2 次撞车也只画 1 个 ⚠。
    expect(inMonthCell(10).querySelectorAll('.cal__warn')).toHaveLength(1);
    expect(monthWarnCount()).toBe(1);
  });

  it('★③ 上月冲突、本月没有 → 头部仍是 2（全库口径），本月网格 ⚠ 为 0（当月口径）', () => {
    // 2/5 在 2026-03 那页网格（2/23 起）之外，所以它既不进网格也不进当月计数。
    render(
      makeDB(
        [makeInterview('iv-old', `${PREV_DAY}T14:00:00`)],
        [makeEvent('ev-old', '14:30', '15:30', PREV_DAY)],
      ),
    );

    // 2 = 一条面试记录 + 一条日程记录（同一次撞车，两方各记一笔）。
    expect(headerConflictCount()).toBe(2);
    // 头部是全库口径，与当前月无关 —— 这正是容易被人「顺手改成当月」的地方。
    expect(monthWarnCount()).toBe(0);
    expect(host.querySelectorAll('.cal__cell .cal__warn')).toHaveLength(0);
    // 当天（3/10）侧栏当然是干净的。
    expect(sideConflictBlocks()).toBe(0);
  });

  it('无冲突：1 面试 × 1 日程不重叠 → 头部走 else 分支，侧栏 0 块、网格 0 个 ⚠', () => {
    // 14:00-15:00 与 15:00-16:00 相邻但**不**重叠（半开区间）。
    render(makeDB([makeInterview('iv-1', `${DAY}T14:00:00`)], [makeEvent('ev-1', '15:00', '16:00')]));

    expect(headerLine().textContent).toContain('1 场面试 · 1 条日程');
    expect(headerLine().textContent).toContain('暂无冲突记录');
    expect(headerConflictCount()).toBeNull();
    expect(sideConflictBlocks()).toBe(0);
    expect(sideConflictMessages()).toBe(0);
    expect(monthWarnCount()).toBe(0);
  });
});
