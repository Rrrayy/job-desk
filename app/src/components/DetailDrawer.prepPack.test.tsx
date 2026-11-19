// @vitest-environment jsdom
/**
 * U1 面试备战包 —— 组件级验收（裸 react-dom + act，同 DetailDrawer.test.tsx 模式）。
 *
 * 这一组守四件事：
 * 1. 未开始的面试里，准备清单**上方**真的渲染出 ≥3 条建议，每条都带「加入清单」按钮；
 * 2. 点一次才写库，写进去的是 `{ id: 'p_…', text, done: false }`（不为用户勾选）；
 * 3. **刷新路径**：把库走一遍 `validateV2`（启动时每次都跑的那个白名单）之后，
 *    这一条**还在**、且字段一个不多 —— 这是防「来源字段偷偷写进库」的唯一硬手段；
 * 4. 已经开始的 / 已有结果的面试不备战（面板不出现）。
 *
 * 种子说明：`scheduledAt` 用**不带 Z 的本地时刻**，与 `parseFlexible` / `fmtDateTime`
 * 的语义一致，所以 `TZ=UTC` 下跑也成立。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { DetailDrawer } from './DetailDrawer';
import type { AppApi } from '../lib/api';
import { emptyDB } from '../lib/defaults';
import { DEFAULT_OFFER_WEIGHTS } from '../lib/offer/score';
import { validateV2 } from '../lib/validateV2';
import type { Application, DB, Interview, InterviewExperience, Question } from '../types';

// 显式声明 act 环境：否则 React 19 的并发渲染会在每次 act 时刷一条 warning
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 10, 20, 10, 0, 0);

function makeApp(overrides: Partial<Application> = {}): Application {
  return {
    id: 'app-1',
    companyId: 'c-1',
    jobTitle: '前端实习',
    status: 'scheduled',
    statusChangedAt: '2026-11-01T01:00:00.000Z',
    lastActivityAt: '2026-11-01T01:00:00.000Z',
    createdAt: '2026-11-01T01:00:00.000Z',
    updatedAt: '2026-11-01T01:00:00.000Z',
    rejectedAtRound: null,
    ...overrides,
  };
}

function makeInterview(overrides: Partial<Interview> = {}): Interview {
  return {
    id: 'iv-1',
    applicationId: 'app-1',
    round: 2,
    scheduledAt: '2026-11-25T14:00:00',
    format: 'video',
    result: 'pending',
    ...overrides,
  };
}

function experience(
  overrides: Partial<InterviewExperience> & Pick<InterviewExperience, 'id' | 'companyName'>,
): InterviewExperience {
  return {
    applicationId: null,
    round: 1,
    interviewDate: '2026-09-10',
    result: 'passed',
    source: 'self',
    createdAt: '2026-09-10T10:00:00.000Z',
    updatedAt: '2026-09-10T10:00:00.000Z',
    ...overrides,
  };
}

function question(overrides: Partial<Question> & Pick<Question, 'id' | 'experienceId' | 'text'>): Question {
  return {
    category: 'algo',
    difficulty: 2,
    mastery: 0,
    tags: [],
    reviewCount: 0,
    createdAt: '2026-09-10T10:00:00.000Z',
    updatedAt: '2026-09-10T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * 5 条建议的库：第 1 档 3 条（上一场挂在「算法」×2、「八股」×1）、
 * 第 2 档 1 条（这家问过）、第 3 档 1 条（别家到期题）。
 */
function makeDb(): DB {
  const db = emptyDB();
  db.companies = [
    { id: 'c-1', name: '某某科技', shortName: '某某', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'c-2', name: '别家公司', createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  db.applications = [makeApp()];
  db.interviews = [makeInterview()];
  db.experiences = [
    experience({ id: 'exp_failed', companyName: '某某科技', result: 'failed' }),
    experience({ id: 'exp_self', applicationId: 'app-1', companyName: '某某科技', interviewDate: '2026-10-01' }),
    experience({ id: 'exp_other', companyName: '别家公司', interviewDate: '2026-08-01' }),
  ];
  db.questions = [
    question({ id: 'qf1', experienceId: 'exp_failed', category: 'algo', text: '手写 Promise.all', rootCause: 'conceptGap' }),
    question({ id: 'qf2', experienceId: 'exp_failed', category: 'algo', text: '手写防抖', rootCause: 'forgot', mastery: 1 }),
    question({ id: 'qf3', experienceId: 'exp_failed', category: 'concept', text: '事件循环', rootCause: 'conceptGap' }),
    question({ id: 'qs1', experienceId: 'exp_self', category: 'project', text: '项目难点', mastery: 1, nextReviewAt: '2026-12-30' }),
    question({ id: 'qd1', experienceId: 'exp_other', category: 'behavior', text: '冲突解决', mastery: 1, nextReviewAt: '2026-11-01' }),
  ];
  return db;
}

interface Harness {
  api: AppApi;
  toast: Mock;
  /** 当前库（写入后是**新对象**，与真实 mutate 的 clone 语义一致，useMemo 才会重算） */
  current: () => DB;
}

function makeApi(initial: DB): Harness {
  const state = { db: initial };
  const toast = vi.fn();
  const api = {
    // getter：写入后拿到的是新对象，和 App 的 cloneDB 行为对齐
    get db(): DB {
      return state.db;
    },
    now: NOW,
    view: 'board',
    selectedId: 'app-1',
    highlightedId: null,
    closeDetail: vi.fn(),
    openDetail: vi.fn(),
    openNew: vi.fn(),
    changeStatus: vi.fn(),
    addNote: vi.fn(),
    deleteNote: vi.fn(),
    addInterview: vi.fn(),
    updateInterview: (id: string, patch: Partial<Interview>) => {
      state.db = {
        ...state.db,
        interviews: state.db.interviews.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      };
    },
    deleteInterview: vi.fn(),
    updateApplication: vi.fn(),
    updateCompany: vi.fn(),
    updateSettings: vi.fn(),
    deleteApplication: vi.fn(),
    openExperience: vi.fn(),
    openQuickNote: vi.fn(),
    toast,
    offer: {
      candidates: [],
      weights: DEFAULT_OFFER_WEIGHTS,
      setWeights: vi.fn(),
      saveOffer: vi.fn(),
      saveDecision: vi.fn(),
      decision: null,
    },
    company: {
      dossierId: null,
      openDossier: vi.fn(),
      closeDossier: vi.fn(),
      saveExtras: vi.fn(),
      sameName: () => [],
      openQuestionBank: vi.fn(),
    },
    ai: {
      ready: false,
      readyReason: '尚未配置 AI 服务地址（设置 → AI 服务）',
      acceptSuggestions: vi.fn(),
      rejectSuggestions: vi.fn(),
      clearRequestLog: vi.fn(),
      runScenario: vi.fn(),
    },
  } as unknown as AppApi;
  return { api, toast, current: () => state.db };
}

describe('U1 面试备战包（jsdom）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  const mount = async (api: AppApi): Promise<void> => {
    await act(async () => {
      root?.render(<DetailDrawer api={api} />);
    });
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
  });

  const panel = (): HTMLElement | null => container.querySelector('[aria-label="建议带进去"]');
  const suggestionRows = (): HTMLElement[] =>
    panel() ? [...(panel() as HTMLElement).querySelectorAll<HTMLElement>('li')] : [];
  const addButtons = (): HTMLButtonElement[] =>
    panel()
      ? [...(panel() as HTMLElement).querySelectorAll<HTMLButtonElement>('button')].filter((button) =>
          (button.textContent || '').includes('加入清单'),
        )
      : [];
  /** 真正的准备清单（面板之外的 `.prep-item` 才是它） */
  const checklistItems = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('.prep-item')];

  it('★ 未开始的面试：面板渲染 ≥3 条建议，每条都带「加入清单」按钮，且排在准备清单上方', async () => {
    const { api } = makeApi(makeDb());
    await mount(api);

    expect(panel()).not.toBeNull();
    expect(suggestionRows().length).toBeGreaterThanOrEqual(3);
    expect(addButtons()).toHaveLength(suggestionRows().length);

    // 每条建议都写了来源（来源只在渲染时算，不进库）
    for (const row of suggestionRows()) {
      expect((row.textContent || '').length).toBeGreaterThan(10);
    }
    expect((panel() as HTMLElement).textContent).toContain('上次挂在「算法」·概念没懂');
    expect((panel() as HTMLElement).textContent).toContain('这家问过');

    // 位置：面板在准备清单之前（DOM 顺序，不是 CSS 顺序）
    const checklist = container.querySelector('.iv-card__prep:not([aria-label])') as HTMLElement;
    expect(checklist).not.toBeNull();
    expect((panel() as HTMLElement).compareDocumentPosition(checklist)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(checklistItems()).toHaveLength(0); // 还没点过，清单是空的
  });

  it('★ 点一次「加入清单」→ 写一条 { id: p_…, text, done:false }，不替用户勾选、不说可撤销', async () => {
    const { api, toast, current } = makeApi(makeDb());
    await mount(api);

    const first = suggestionRows()[0];
    const firstText = (first.querySelector('span') as HTMLElement).textContent || '';
    expect(firstText).toBe('手写 Promise.all');

    await act(async () => {
      addButtons()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const checklist = current().interviews[0].prepChecklist || [];
    expect(checklist).toHaveLength(1);
    expect(checklist[0].id).toMatch(/^p_/);
    expect(checklist[0].text).toBe('手写 Promise.all');
    expect(checklist[0].done).toBe(false);
    // 字段集合精确断言：多一个 source 字段这里就红
    expect(Object.keys(checklist[0]).sort()).toEqual(['done', 'id', 'text']);

    expect(toast).toHaveBeenCalledWith('已加进准备清单');
    for (const call of toast.mock.calls) {
      expect(String(call[0])).not.toContain('撤销');
    }
  });

  it('★ 刷新路径：validateV2 重解析之后这一条还在、字段一个不多，且面板不再重复建议它', async () => {
    const { api, current } = makeApi(makeDb());
    await mount(api);

    await act(async () => {
      addButtons()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await mount(api); // 写库后重渲染：清单多一条、面板少一条

    expect(checklistItems()).toHaveLength(1);
    expect(checklistItems()[0].textContent).toContain('手写 Promise.all');
    expect(suggestionRows().some((row) => (row.textContent || '').includes('手写 Promise.all'))).toBe(false);

    // 启动路径：loadDB → validateV2（白名单会剥掉任何多余字段）
    const parsed = validateV2(JSON.parse(JSON.stringify(current())) as unknown);
    if (!parsed.ok) throw new Error(`validateV2 拒绝了自己的库：${parsed.error}`);
    const survivor = parsed.db.interviews.find((item) => item.id === 'iv-1');
    expect(survivor?.prepChecklist).toHaveLength(1);
    expect(survivor?.prepChecklist?.[0]).toEqual({
      id: expect.stringMatching(/^p_/),
      text: '手写 Promise.all',
      done: false,
    });

    // 用「刷新后」的库重新挂载，清单里那条仍然渲染得出来
    act(() => root?.unmount());
    root = createRoot(container);
    await mount(makeApi(parsed.db).api);
    expect(checklistItems()).toHaveLength(1);
    expect(checklistItems()[0].textContent).toContain('手写 Promise.all');
  });

  it('已经开始的 / 已有结果的面试不备战：面板不出现', async () => {
    const past = makeDb();
    past.interviews = [makeInterview({ scheduledAt: '2026-11-01T14:00:00' })];
    await mount(makeApi(past).api);
    expect(panel()).toBeNull();

    act(() => root?.unmount());
    root = createRoot(container);
    const finished = makeDb();
    finished.interviews = [makeInterview({ result: 'passed' })];
    await mount(makeApi(finished).api);
    expect(panel()).toBeNull();
  });
});
