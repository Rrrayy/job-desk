// @vitest-environment jsdom
/**
 * 模板选择器（8 张卡片）。
 *
 * 这里只断言「选择器自己的职责」：8 张卡片都在、当前项被标出来、点击回传 id、
 * 缩略图真的进了 DOM、未登记 id 有明话。至于「缩略图与成品布局一致」——
 * 那是构造上成立的（缩略图由 `layout` 生成，见 thumbs.ts），不靠测试保证。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TemplateId } from '../../types';
import { TEMPLATE_LIST } from '../../resume/templates';
import { TemplatePicker } from './TemplatePicker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('TemplatePicker（jsdom）', () => {
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

  async function render(value: TemplateId, onChange: (id: TemplateId) => void = () => undefined): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root.render(<TemplatePicker value={value} onChange={onChange} />);
    });
  }

  const cards = (): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>('.tpl-card'));

  it('★ 8 套全部列出，顺序与 TEMPLATE_ORDER 一致（P0 在前）', async () => {
    await render('tech-single');
    expect(cards()).toHaveLength(8);
    expect(cards().map((card) => card.querySelector('.tpl-card__name')?.textContent)).toEqual(
      TEMPLATE_LIST.map((template) => template.name),
    );
  });

  it('★ 缩略图真的渲染进 DOM（8 个 <svg>，且不是外链 <img>）', async () => {
    await render('tech-single');
    expect(container.querySelectorAll('.tpl-card__thumb svg')).toHaveLength(8);
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });

  it('当前模板被标成 checked，其余不是（radio 语义）', async () => {
    await render('academic');
    expect(cards().filter((card) => card.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    const active = cards().find((card) => card.getAttribute('aria-checked') === 'true')!;
    expect(active.querySelector('.tpl-card__name')?.textContent).toBe('学术科研');
    expect(active.className).toContain('tpl-card--on');
    expect(container.querySelector('[role="radiogroup"]')).not.toBeNull();
  });

  it('点一张卡片 → 回传那个 id（只回传 id，不改内容）', async () => {
    const onChange = vi.fn();
    await render('tech-single', onChange);
    const target = cards().find((card) => card.textContent?.includes('创意个性'))!;
    await act(async () => {
      target.click();
    });
    expect(onChange).toHaveBeenCalledWith('creative');
  });

  it('布局名与目标方向都在无障碍标签里（屏幕阅读器不必猜这张图是什么）', async () => {
    await render('tech-single');
    const timeline = cards().find((card) => card.textContent?.includes('社招简洁'))!;
    expect(timeline.getAttribute('aria-label')).toContain('时间轴');
    expect(timeline.querySelector('.tpl-card__layout')?.textContent).toBe('时间轴');
  });

  it('★ 库里存着未登记的 id → 明说「已回落到通用表单」，不是静默空白', async () => {
    await render('legacy-template' as TemplateId);
    expect(cards().every((card) => card.getAttribute('aria-checked') === 'false')).toBe(true);
    expect(container.querySelector('.tpl-picker__warn')?.textContent).toContain('未登记');
  });

  it('登记已知 id 时没有那行警告（别把正常状态也弄成红灯）', async () => {
    await render('minimal-bw');
    expect(container.querySelector('.tpl-picker__warn')).toBeNull();
  });
});
