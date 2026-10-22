// @vitest-environment jsdom
/**
 * MasteryCategoryPicks（T-QB ①②③ 共用下拉）：
 * - form 形态带可见标签（编辑态），inline 形态无标签只靠 aria-label（快记行内）
 * - onChange 只回传被改的那个字段 —— 父组件用对象展开写回，多传会把未改字段一起覆盖
 * - 分类选「未分类」回传 null（库里 null = 没标，不是空字符串）
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MasteryCategoryPicks } from './MasteryCategoryPicks';

describe('MasteryCategoryPicks（jsdom）', () => {
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

  async function render(props: Parameters<typeof MasteryCategoryPicks>[0]): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root.render(<MasteryCategoryPicks {...props} />);
    });
  }

  function setSelect(select: HTMLSelectElement, value: string): void {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  it('form 形态：带「掌握度 / 分类」可见标签，改掌握度只回传 mastery', async () => {
    const onChange = vi.fn();
    await render({ mastery: 0, category: null, onChange, variant: 'form' });

    const labels = Array.from(container.querySelectorAll('.picks--form .field__label')).map((el) => el.textContent);
    expect(labels).toEqual(['掌握度', '分类']);

    const mastery = container.querySelector<HTMLSelectElement>('select[aria-label="掌握度"]')!;
    await act(async () => setSelect(mastery, '2'));
    expect(onChange).toHaveBeenCalledWith({ mastery: 2 });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('inline 形态：无可见标签；分类选「未分类」回传 null（库里 null = 没标）', async () => {
    const onChange = vi.fn();
    await render({ mastery: 1, category: 'algo', onChange });

    expect(container.querySelectorAll('.field__label')).toHaveLength(0);
    const category = container.querySelector<HTMLSelectElement>('select[aria-label="分类"]')!;
    expect(category.value).toBe('algo');

    await act(async () => setSelect(category, ''));
    expect(onChange).toHaveBeenCalledWith({ category: null });
  });

  it('6 个分类选项齐全（含「未分类」空值项）', async () => {
    await render({ mastery: 0, category: null, onChange: vi.fn() });
    const category = container.querySelector<HTMLSelectElement>('select[aria-label="分类"]')!;
    expect(category.options).toHaveLength(7); // 未分类 + algo/concept/project/behavior/reverse/hr
    const mastery = container.querySelector<HTMLSelectElement>('select[aria-label="掌握度"]')!;
    expect(mastery.options).toHaveLength(3); // 不会 / 模糊 / 会
  });
});
