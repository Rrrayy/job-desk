// @vitest-environment jsdom
/**
 * QuickNote（v0.9 / T-QB ①）：每行两个下拉（掌握度 / 分类）+ 「记完了」按各自选择一次落库。
 *
 * 覆盖：
 * - 验收：记 3 题分别选 不会 / 模糊 / 会，其中两题改了分类 → addQuickNote 收到逐条 mastery/category
 * - 落库时机（PRD §20.2）：Enter 只进本地列表，**一次 addQuickNote** 写完面经壳 + 全部题
 * - 默认值不变：不碰下拉 = 不会 + 未分类（v0.8 行为），所以老路径没变长
 * - 末尾没按 Enter 的内容也一起落库（按默认值），不让用户白打一遍
 * - 待记行可删；公司为空 / 全部重复 → 不关浮层、给错误提示（写不进库就不假装成功）
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickNote } from './QuickNote';
import type { AppApi, QuickNoteInput, QuickNoteResult } from '../../lib/api';
import { emptyDB } from '../../lib/defaults';

const NOW = new Date(2026, 9, 20, 10, 0, 0);

/** written 决定「真的写进去几条」，用来模拟重复 / 超长被跳过 */
function makeApi(writtenOf?: (items: unknown[]) => number) {
  const addQuickNote = vi.fn((input: QuickNoteInput): QuickNoteResult => {
    const written = writtenOf ? writtenOf(input.items) : input.items.length;
    if (written === 0) {
      return { ok: false, reason: '这些题都没存进去（可能是重复或超长），改一下再试' };
    }
    return { ok: true, experienceId: 'exp-1', written, skipped: input.items.length - written };
  });
  const api = {
    db: emptyDB(),
    now: NOW,
    quickNote: {},
    addQuickNote,
    toast: vi.fn(),
  };
  return api;
}

/** React 受控 input/textarea 的原生写入（直接赋值不触发 onChange） */
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

function pressEnter(input: HTMLInputElement): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

describe('QuickNote 逐题选择掌握度 / 分类（jsdom）', () => {
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

  async function render(api: ReturnType<typeof makeApi>): Promise<{ onClose: ReturnType<typeof vi.fn> }> {
    const onClose = vi.fn();
    root = createRoot(container);
    await act(async () => {
      root.render(<QuickNote api={api as unknown as AppApi} onClose={onClose} />);
    });
    return { onClose };
  }

  const companyInput = (): HTMLInputElement =>
    container.querySelector<HTMLInputElement>('input[placeholder="字节跳动"]')!;
  const draftInput = (): HTMLInputElement => container.querySelector<HTMLInputElement>('.quick-note__input')!;
  const pick = (row: number, field: '掌握度' | '分类'): HTMLSelectElement =>
    container.querySelector<HTMLSelectElement>(`select[aria-label="第 ${row} 题${field}"]`)!;
  const clickText = (text: string): void => {
    const button = Array.from(container.querySelectorAll('button')).find((item) =>
      item.textContent?.includes(text),
    );
    button?.click();
  };

  /** 取第一次 addQuickNote 的入参（items 是重点，experience 只需核对壳上的公司/日期） */
  function firstCall(api: ReturnType<typeof makeApi>): QuickNoteInput {
    return api.addQuickNote.mock.calls[0]![0];
  }

  it('★ 3 题分别 不会/模糊/会，两题改分类 → 一次 addQuickNote 带上逐条 mastery + category', async () => {
    const api = makeApi();
    const { onClose } = await render(api);

    await act(async () => setValue(companyInput(), '字节跳动'));
    for (const text of ['手写 Promise.all', '事件循环', '项目难点']) {
      await act(async () => setValue(draftInput(), text));
      await act(async () => pressEnter(draftInput()));
    }

    // Enter 只进本地列表：此刻一个字都还没落库
    expect(api.addQuickNote).not.toHaveBeenCalled();
    expect(container.querySelectorAll('.quick-note__item')).toHaveLength(3);

    // 默认值：都没选 → 不会 + 未分类
    expect(pick(1, '掌握度').value).toBe('0');
    expect(pick(1, '分类').value).toBe('');
    expect(container.textContent).toContain('记完了（3 题）');

    await act(async () => setSelect(pick(2, '掌握度'), '1'));
    await act(async () => setSelect(pick(3, '掌握度'), '2'));
    await act(async () => setSelect(pick(1, '分类'), 'algo'));
    await act(async () => setSelect(pick(2, '分类'), 'project'));

    await act(async () => clickText('记完了'));

    expect(api.addQuickNote).toHaveBeenCalledTimes(1);
    const call = firstCall(api);
    expect(call.items).toEqual([
      { text: '手写 Promise.all', mastery: 0, category: 'algo' },
      { text: '事件循环', mastery: 1, category: 'project' },
      { text: '项目难点', mastery: 2, category: null },
    ]);
    // 面经壳与题一起写（同一次调用 = 一个撤销点）
    expect(call.experience).toMatchObject({
      companyName: '字节跳动',
      interviewDate: '2026-10-20',
      result: 'pending',
      source: 'self',
    });
    expect(api.toast).toHaveBeenCalledWith(expect.stringContaining('已记 3 题'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('末尾没按 Enter 的内容也落库（默认 不会 + 未分类），不丢字', async () => {
    const api = makeApi();
    const { onClose } = await render(api);

    await act(async () => setValue(companyInput(), '字节跳动'));
    await act(async () => setValue(draftInput(), '第一题'));
    await act(async () => pressEnter(draftInput()));
    await act(async () => setValue(draftInput(), '第二题还没回车'));
    expect(container.textContent).toContain('记完了（2 题）');

    await act(async () => clickText('记完了'));

    expect(firstCall(api).items).toEqual([
      { text: '第一题', mastery: 0, category: null },
      // 尾部这条没经过行内下拉，按默认值（不会 + 未分类）走同一个批量入参
      { text: '第二题还没回车' },
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('待记行可以删掉：删了就不再进批量入参', async () => {
    const api = makeApi();
    const { onClose } = await render(api);

    await act(async () => setValue(companyInput(), '字节跳动'));
    for (const text of ['题一', '题二', '题三']) {
      await act(async () => setValue(draftInput(), text));
      await act(async () => pressEnter(draftInput()));
    }
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="删掉第 2 题"]')!.click();
    });
    expect(container.querySelectorAll('.quick-note__item')).toHaveLength(2);
    expect(container.textContent).toContain('记完了（2 题）');

    await act(async () => clickText('记完了'));
    expect(firstCall(api).items).toEqual([
      { text: '题一', mastery: 0, category: null },
      { text: '题三', mastery: 0, category: null },
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('公司没填 → Enter 不进列表，只提示；不写库', async () => {
    const api = makeApi();
    const { onClose } = await render(api);

    await act(async () => setValue(draftInput(), '手写 Promise.all'));
    await act(async () => pressEnter(draftInput()));

    expect(container.querySelectorAll('.quick-note__item')).toHaveLength(0);
    expect(container.textContent).toContain('先填公司名');
    expect(api.addQuickNote).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('全部重复（一条都没写进去）→ 浮层不关，报错说清楚', async () => {
    const api = makeApi(() => 0);
    const { onClose } = await render(api);

    await act(async () => setValue(companyInput(), '字节跳动'));
    await act(async () => setValue(draftInput(), '重复题'));
    await act(async () => pressEnter(draftInput()));
    await act(async () => clickText('记完了'));

    expect(container.textContent).toContain('这些题都没存进去');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('部分重复 → toast 说清楚跳过了几条', async () => {
    const api = makeApi(() => 1);
    const { onClose } = await render(api);

    await act(async () => setValue(companyInput(), '字节跳动'));
    for (const text of ['题一', '题二']) {
      await act(async () => setValue(draftInput(), text));
      await act(async () => pressEnter(draftInput()));
    }
    await act(async () => clickText('记完了'));

    expect(api.toast).toHaveBeenCalledWith(expect.stringContaining('1 题重复或超长已跳过'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
