// @vitest-environment jsdom
/**
 * QuestionBank（v0.9 / T-QB ②③）：按场折叠的概览卡 + 行内编辑。
 *
 * 覆盖：
 * - 默认每场一张概览卡（20 题 1 场 → 1 张卡），**折叠态不渲染任何题干 DOM**
 * - 点卡展开 20 行、再点收回（展开态只存本地 state）
 * - 场序 = 面试日期倒序；上限 30 张卡，超了给「用上面的筛选缩小范围」
 * - 筛选「会」→ 卡上计数与展开内容只含命中题；某场 0 命中 → 整卡不渲染
 * - 行内编辑：改分类 + 改题干 → editQuestion 收到一次 patch（App 侧一次 mutate + 一条撤销栈）
 * - 同时只允许一行编辑；有未保存改动时切行 / 取消都要先说一声
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuestionBank } from './QuestionBank';
import type { AppApi } from '../../lib/api';
import { emptyDB } from '../../lib/defaults';
import type { DB, InterviewExperience, Mastery, Question } from '../../types';

const NOW = new Date(2026, 9, 20, 10, 0, 0);

function makeExperience(overrides: Partial<InterviewExperience> = {}): InterviewExperience {
  return {
    id: 'exp-1',
    applicationId: null,
    companyName: '字节跳动',
    jobTitle: '抖音前端',
    round: 2,
    interviewDate: '2026-10-18',
    result: 'pending',
    source: 'self',
    createdAt: '2026-10-18T10:00:00.000Z',
    updatedAt: '2026-10-18T10:00:00.000Z',
    ...overrides,
  };
}

function makeQuestion(index: number, overrides: Partial<Question> = {}): Question {
  const mastery = (index % 3) as Mastery;
  return {
    id: `q-${index}`,
    experienceId: 'exp-1',
    category: index % 2 === 0 ? 'algo' : null,
    difficulty: 2,
    text: `第 ${index} 题：手写 Promise.all 的边界`,
    mastery,
    tags: [],
    nextReviewAt: '2026-10-20',
    reviewCount: index % 4,
    createdAt: '2026-10-18T10:00:00.000Z',
    updatedAt: '2026-10-18T10:00:00.000Z',
    ...overrides,
  };
}

function makeDb(questions: Question[], experiences: InterviewExperience[] = [makeExperience()]): DB {
  const db = emptyDB();
  db.experiences = experiences;
  db.questions = questions;
  return db;
}

/** React 受控 input/textarea/select 的原生写入（直接赋值不触发 onChange） */
function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelect(select: HTMLSelectElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function makeApi(db: DB) {
  return {
    db,
    now: NOW,
    editQuestion: vi.fn(),
    updateQuestion: vi.fn(),
    deleteQuestion: vi.fn(),
    reviewQuestion: vi.fn(),
    toast: vi.fn(),
    openQuickNote: vi.fn(),
    openExperience: vi.fn(),
    closeDetail: vi.fn(),
  };
}

describe('QuestionBank 按场折叠 + 行内编辑（jsdom）', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(db: DB): Promise<ReturnType<typeof makeApi>> {
    const api = makeApi(db);
    root = createRoot(container);
    await act(async () => {
      root.render(<QuestionBank api={api as unknown as AppApi} onRecord={vi.fn()} />);
    });
    return api;
  }

  const groupHeads = (): HTMLButtonElement[] =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('.qb__group-head'));
  const rows = (): HTMLLIElement[] => Array.from(container.querySelectorAll<HTMLLIElement>('.qb__row'));
  const buttonByText = (text: string): HTMLButtonElement | undefined =>
    Array.from(container.querySelectorAll('button')).find((item) => item.textContent === text);

  it('★ 20 题 1 场 → 默认 1 张概览卡，折叠态不渲染题干，展开 20 行，再点收回', async () => {
    const questions = Array.from({ length: 20 }, (_, i) => makeQuestion(i + 1));
    await render(makeDb(questions));

    expect(container.querySelectorAll('.qb__group')).toHaveLength(1);
    expect(groupHeads()).toHaveLength(1);
    // 折叠态：一行题目都不渲染，题干文字根本不进 DOM（验收 32 的断言点）
    expect(rows()).toHaveLength(0);
    expect(container.textContent).not.toContain('第 1 题');
    // 卡头：公司 · 岗位 · 轮次 · 日期 + 「20 题 · 其中不会 M」
    const head = groupHeads()[0];
    expect(head.textContent).toContain('字节跳动');
    expect(head.textContent).toContain('抖音前端');
    expect(head.textContent).toContain('第 2 轮');
    expect(head.textContent).toContain('2026-10-18');
    // mastery = index % 3，index 1..20 → mastery 0 的是 3,6,9,12,15,18 → 6 题
    expect(head.textContent).toContain('20 题 · 其中不会 6');
    expect(head.getAttribute('aria-expanded')).toBe('false');

    await act(async () => groupHeads()[0].click());
    expect(rows()).toHaveLength(20);
    expect(groupHeads()[0].getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('第 1 题');

    await act(async () => groupHeads()[0].click());
    expect(rows()).toHaveLength(0);
    expect(container.textContent).not.toContain('第 1 题');
  });

  it('场序 = 面试日期倒序（同一天保持录入顺序）', async () => {
    const db = makeDb(
      [
        makeQuestion(1, { experienceId: 'exp-old' }),
        makeQuestion(2, { experienceId: 'exp-new' }),
        makeQuestion(3, { experienceId: 'exp-mid' }),
      ],
      [
        makeExperience({ id: 'exp-old', companyName: '老公司', interviewDate: '2026-09-01' }),
        makeExperience({ id: 'exp-new', companyName: '新公司', interviewDate: '2026-10-22' }),
        makeExperience({ id: 'exp-mid', companyName: '中间公司', interviewDate: '2026-10-01' }),
      ],
    );
    await render(db);
    const titles = groupHeads().map((head) => head.textContent ?? '');
    expect(titles).toHaveLength(3);
    expect(titles[0]).toContain('新公司');
    expect(titles[1]).toContain('中间公司');
    expect(titles[2]).toContain('老公司');
  });

  it('超过 30 场 → 只渲染 30 张卡，并提示用筛选缩小范围', async () => {
    const experiences = Array.from({ length: 31 }, (_, i) =>
      makeExperience({ id: `exp-${i}`, companyName: `公司${i}`, interviewDate: '2026-10-0' + ((i % 9) + 1) }),
    );
    const questions = experiences.map((exp, i) => makeQuestion(i + 1, { id: `q-${i}`, experienceId: exp.id }));
    await render(makeDb(questions, experiences));

    expect(groupHeads()).toHaveLength(30);
    expect(container.textContent).toContain('还有 1 场没显示');
  });

  it('筛选「会」→ 卡上计数与展开内容只含命中题', async () => {
    const questions = Array.from({ length: 20 }, (_, i) => makeQuestion(i + 1));
    await render(makeDb(questions));

    // 掌握度筛选是工具栏第三个 select（公司 / 分类 / 掌握度）
    const selects = Array.from(container.querySelectorAll<HTMLSelectElement>('.qb__toolbar select'));
    await act(async () => setSelect(selects[2], '2'));

    expect(groupHeads()).toHaveLength(1);
    // mastery 2 的是 2,5,8,11,14,17,20 → 7 题，且这些题里没有「不会」
    expect(groupHeads()[0].textContent).toContain('7 题 · 其中不会 0');
    // 顶部汇总与卡上口径一致（共 20 · 筛选 7 · 命中 1 场）
    expect(container.textContent).toContain('共 20 题 · 当前筛选 7 题 · 命中 1 场');

    await act(async () => groupHeads()[0].click());
    expect(rows()).toHaveLength(7);
    for (const row of rows()) expect(row.textContent).toContain('会');
  });

  it('某场没有任何命中题 → 整卡不渲染（不出现空卡）', async () => {
    const db = makeDb(
      [makeQuestion(1, { mastery: 2 }), makeQuestion(2, { mastery: 0, experienceId: 'exp-2' })],
      [makeExperience(), makeExperience({ id: 'exp-2', companyName: '阿里', round: 1 })],
    );
    await render(db);
    expect(groupHeads()).toHaveLength(2);

    // 搜索一个只命中 exp-2 的题干
    const search = container.querySelector<HTMLInputElement>('.qb__filter--search input')!;
    await act(async () => setValue(search, '第 2 题'));

    expect(groupHeads()).toHaveLength(1);
    expect(groupHeads()[0].textContent).toContain('阿里');
  });

  it('★ 行内编辑：改分类 + 改题干 → editQuestion 收到一次 patch；一次只允许一行', async () => {
    const questions = [makeQuestion(1, { mastery: 2, category: 'algo', text: '旧题干' }), makeQuestion(2)];
    const api = await render(makeDb(questions));

    await act(async () => groupHeads()[0].click());
    const editButtons = (): HTMLButtonElement[] =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('.qb__row-edit'));
    expect(editButtons()).toHaveLength(2);

    await act(async () => editButtons()[0].click());
    expect(container.querySelectorAll('.qb__editor')).toHaveLength(1);
    // 点另一行的「编辑」→ 切换过去，不会同时开两个编辑态
    await act(async () => editButtons()[0].click());
    expect(container.querySelectorAll('.qb__editor')).toHaveLength(1);
    // 切回第 1 题再改，断言落到 q-1
    await act(async () => editButtons()[0].click());
    expect(container.querySelectorAll('.qb__editor')).toHaveLength(1);

    const editor = container.querySelector('.qb__editor')!;
    const textarea = editor.querySelector<HTMLTextAreaElement>('textarea[aria-label="题干"]')!;
    const mastery = editor.querySelector<HTMLSelectElement>('select[aria-label="掌握度"]')!;
    const category = editor.querySelector<HTMLSelectElement>('select[aria-label="分类"]')!;
    const answer = editor.querySelector<HTMLTextAreaElement>('textarea[aria-label="我的回答"]')!;

    await act(async () => setValue(textarea, '新题干'));
    await act(async () => setSelect(mastery, '1'));
    await act(async () => setSelect(category, 'project'));
    await act(async () => setValue(answer, '我当时答的是…'));

    await act(async () => buttonByText('保存')!.click());

    expect(api.editQuestion).toHaveBeenCalledTimes(1);
    expect(api.editQuestion).toHaveBeenCalledWith('q-1', {
      text: '新题干',
      mastery: 1,
      category: 'project',
      myAnswer: '我当时答的是…',
    });
    // 保存后退出编辑态；也不该走「我又复习了一遍」的入口
    expect(container.querySelectorAll('.qb__editor')).toHaveLength(0);
    expect(api.reviewQuestion).not.toHaveBeenCalled();
  });

  it('有未保存改动时点另一行的「编辑」会被拦下（不静默丢弃）', async () => {
    const api = await render(makeDb([makeQuestion(1, { text: '旧题干' }), makeQuestion(2)]));
    await act(async () => groupHeads()[0].click());
    await act(async () => container.querySelector<HTMLButtonElement>('.qb__row-edit')!.click());

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="题干"]')!;
    await act(async () => setValue(textarea, '改了但没保存'));

    await act(async () => container.querySelector<HTMLButtonElement>('.qb__row-edit')!.click());

    expect(api.toast).toHaveBeenCalledWith(expect.stringContaining('未保存的修改'));
    expect(container.querySelectorAll('.qb__editor')).toHaveLength(1);
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="题干"]')!.value).toBe('改了但没保存');
    expect(api.editQuestion).not.toHaveBeenCalled();
  });

  it('取消：第一次点先提示「有未保存的修改」，第二次才真的丢掉', async () => {
    const api = await render(makeDb([makeQuestion(1, { text: '旧题干' })]));
    await act(async () => groupHeads()[0].click());
    await act(async () => container.querySelector<HTMLButtonElement>('.qb__row-edit')!.click());

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="题干"]')!;
    await act(async () => setValue(textarea, '改了但不保存'));

    await act(async () => buttonByText('取消')!.click());
    // 第一次点：编辑态还在，并出现一行提示
    expect(container.querySelectorAll('.qb__editor')).toHaveLength(1);
    expect(container.textContent).toContain('有未保存的修改');

    await act(async () => buttonByText('取消')!.click());

    expect(api.editQuestion).not.toHaveBeenCalled();
    expect(container.querySelectorAll('.qb__editor')).toHaveLength(0);
    expect(container.textContent).toContain('旧题干');
  });

  it('题干超过上限时就地提示会截断（不静默）', async () => {
    await render(makeDb([makeQuestion(1)]));
    await act(async () => groupHeads()[0].click());
    await act(async () => container.querySelector<HTMLButtonElement>('.qb__row-edit')!.click());

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="题干"]')!;
    await act(async () => setValue(textarea, '长'.repeat(2001)));
    expect(container.textContent).toContain('题干超过 2000 字，保存后会截断');
  });

  it('题干清空时「保存」置灰（不留空题干进库）', async () => {
    await render(makeDb([makeQuestion(1)]));
    await act(async () => groupHeads()[0].click());
    await act(async () => container.querySelector<HTMLButtonElement>('.qb__row-edit')!.click());

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="题干"]')!;
    await act(async () => setValue(textarea, '   '));

    expect(buttonByText('保存')!.disabled).toBe(true);
  });
});
