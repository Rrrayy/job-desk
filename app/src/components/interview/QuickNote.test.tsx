// @vitest-environment jsdom
/**
 * QuickNote（v0.9 / T-QB ①）：每行两个下拉（掌握度 / 分类）+ 「记完了」按各自选择一次落库。
 *
 * 覆盖：
 * - 验收：记 3 题分别选 不会 / 模糊 / 会，其中两题改了分类 → addQuestions 收到逐条 mastery/category
 * - 默认值不变：不碰下拉 = 不会 + 未分类（v0.8 行为），所以老路径没变长
 * - 末尾没按 Enter 的内容也一起落库（按默认值），不让用户白打一遍
 * - 公司为空 / 全部重复 → 不关浮层、给错误提示（写不进库就不假装成功）
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickNote } from './QuickNote';
import type { AppApi } from '../../lib/api';
import { emptyDB } from '../../lib/defaults';

const NOW = new Date(2026, 9, 20, 10, 0, 0);

function makeApi(addQuestionsImpl?: (id: string, items: unknown[]) => number) {
  const api = {
    db: emptyDB(),
    now: NOW,
    quickNote: {},
    addExperience: vi.fn(() => 'exp-1'),
    addQuestions: vi.fn(addQuestionsImpl ?? ((_id: string, items: unknown[]) => items.length)),
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

  it('★ 3 题分别 不会/模糊/会，两题改分类 → addQuestions 收到逐条 mastery + category', async () => {
    const api = makeApi();
    const { onClose } = await render(api);

    await act(async () => setValue(companyInput(), '字节跳动'));
    for (const text of ['手写 Promise.all', '事件循环', '项目难点']) {
      await act(async () => setValue(draftInput(), text));
      await act(async () => pressEnter(draftInput()));
    }

    // 默认值：都没选 → 不会 + 未分类
    expect(pick(1, '掌握度').value).toBe('0');
    expect(pick(1, '分类').value).toBe('');
    expect(container.textContent).toContain('记完了（3 题）');

    await act(async () => setSelect(pick(2, '掌握度'), '1'));
    await act(async () => setSelect(pick(3, '掌握度'), '2'));
    await act(async () => setSelect(pick(1, '分类'), 'algo'));
    await act(async () => setSelect(pick(2, '分类'), 'project'));

    await act(async () => clickText('记完了'));

    expect(api.addQuestions).toHaveBeenCalledTimes(1);
    expect(api.addQuestions).toHaveBeenCalledWith('exp-1', [
      { text: '手写 Promise.all', mastery: 0, category: 'algo' },
      { text: '事件循环', mastery: 1, category: 'project' },
      { text: '项目难点', mastery: 2, category: null },
    ]);
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

    expect(api.addQuestions).toHaveBeenCalledWith('exp-1', [
      { text: '第一题', mastery: 0, category: null },
      // 尾部这条走「裸字符串」兼容入参 —— 由 addQuestions 补默认值（不会 + 未分类）
      { text: '第二题还没回车' },
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
    expect(api.addQuestions).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('全部重复（addQuestions 返回 0）→ 浮层不关，报错说清楚', async () => {
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
