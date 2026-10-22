// @vitest-environment jsdom
/**
 * SuggestionList 组件测试（v0.8 / T03）：勾选 / 全选 / 接受与忽略回调 /
 * 空态。组件是纯展示，回调由 api.ai.acceptSuggestions / rejectSuggestions
 * （App 侧单次 mutate + 撤销点）承接 —— 生命周期纯函数已在 suggestions.test.ts。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SuggestionList } from './SuggestionList';
import type { AISuggestion } from '../../ai/types';
import type { AISuggestionTargetType } from '../../types';

const NOW = '2026-10-21T10:00:00.000Z';

function suggestion(id: string, targetType: AISuggestionTargetType, content: string, evidence?: string): AISuggestion {
  return {
    id,
    pluginId: 'builtin:d17',
    targetType,
    targetId: targetType === 'staging_field' ? 'st-1' : null,
    fieldPath: 'companyName',
    content,
    ...(evidence ? { evidence } : {}),
    status: 'pending',
    createdAt: NOW,
  };
}

const LIST: AISuggestion[] = [
  suggestion('s-1', 'staging_field', '字节跳动', '原文：字节 前端 25k'),
  suggestion('s-2', 'staging_field', '前端实习生'),
];

describe('SuggestionList', () => {
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

  async function renderList(
    suggestions: AISuggestion[],
    handlers: { onAccept?: (ids: string[]) => void; onReject?: (ids: string[]) => void; evidence?: boolean } = {},
  ): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <SuggestionList
          suggestions={suggestions}
          evidence={handlers.evidence}
          onAccept={handlers.onAccept ?? vi.fn()}
          onReject={handlers.onReject ?? vi.fn()}
        />,
      );
    });
  }

  const rows = (): NodeListOf<HTMLInputElement> =>
    container.querySelectorAll<HTMLInputElement>('[data-testid^="suggestion-s-"] input[type="checkbox"]');
  const buttonByText = (text: string): HTMLButtonElement | undefined =>
    Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes(text));

  it('渲染 pending 建议与证据对照（evidence=true）', async () => {
    await renderList(LIST, { evidence: true });
    expect(container.querySelector('[data-testid="suggestion-s-1"]')?.textContent).toContain('字节跳动');
    expect(container.querySelector('[data-testid="suggestion-s-1"]')?.textContent).toContain('证据：原文：字节 前端 25k');
    expect(container.querySelector('[data-testid="suggestion-s-2"]')?.textContent).toContain('前端实习生');
  });

  it('空列表显示空态文案', async () => {
    await renderList([]);
    expect(container.querySelector('[data-testid="suggestion-empty"]')?.textContent).toContain('暂无 AI 建议');
  });

  it('无勾选时接受/忽略禁用；勾选两条 → 接受回调收到两个 id 且清空勾选', async () => {
    const onAccept = vi.fn();
    await renderList(LIST, { onAccept });
    expect(buttonByText('接受所选')?.disabled).toBe(true);

    await act(async () => {
      rows()[0].click();
      rows()[1].click();
    });
    expect(buttonByText('接受所选')?.disabled).toBe(false);
    await act(async () => {
      buttonByText('接受所选')?.click();
    });
    expect(onAccept).toHaveBeenCalledWith(['s-1', 's-2']);
    expect(Array.from(rows()).every((box) => !box.checked)).toBe(true);
  });

  it('全选 → 忽略回调收到全部 id', async () => {
    const onReject = vi.fn();
    await renderList(LIST, { onReject });
    await act(async () => {
      container.querySelector<HTMLInputElement>('[data-testid="suggestion-select-all"]')?.click();
    });
    expect(buttonByText('忽略所选')?.disabled).toBe(false);
    await act(async () => {
      buttonByText('忽略所选')?.click();
    });
    expect(onReject).toHaveBeenCalledWith(['s-1', 's-2']);
  });
});
