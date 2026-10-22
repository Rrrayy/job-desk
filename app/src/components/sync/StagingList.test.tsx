// @vitest-environment jsdom
/**
 * StagingList 的 D17 入口测试（v0.8 / T05）。
 *
 * 暂存区是「解析失败也不许静默丢」的最后一站（PRD §B.9 P0），
 * AI 只是给它加一个兜底按钮，所以这里的断言全是**边界**：
 * 只有 unparsed / unmapped 行出现按钮；原文为空按钮禁用；
 * AI 未配置时置灰并就地说明原因（不弹窗、不隐藏入口）。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StagingList } from './StagingList';
import type { StagedSyncItem } from '../../types';

const NOW = '2026-10-21T10:00:00.000Z';

function item(over: Partial<StagedSyncItem> = {}): StagedSyncItem {
  return {
    id: 'st-1',
    platform: 'custom',
    reason: 'unparsed',
    parsed: { companyName: '', confidence: {}, overall: 'low' } as unknown as StagedSyncItem['parsed'],
    rawSnippet: '字节跳动 前端开发实习生 25k 北京',
    capturedAt: NOW,
    ...over,
  };
}

describe('StagingList · D17 AI 入口', () => {
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

  async function render(props: Partial<Parameters<typeof StagingList>[0]> = {}): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <StagingList
          items={props.items ?? [item()]}
          onResolve={props.onResolve ?? vi.fn()}
          onClear={props.onClear ?? vi.fn()}
          onManualAdd={props.onManualAdd}
          onAiRetry={props.onAiRetry}
          aiReady={props.aiReady}
          aiReason={props.aiReason}
        />,
      );
    });
  }

  it('unparsed 行：AI 已配置 → 按钮可用，点击只把这一行交给回调', async () => {
    const onAiRetry = vi.fn();
    await render({ onAiRetry, aiReady: true });
    const button = container.querySelector('[data-testid="ai-retry-st-1"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('title')).toContain('只发这段原文');

    await act(async () => {
      button.click();
    });
    expect(onAiRetry).toHaveBeenCalledTimes(1);
    expect(onAiRetry.mock.calls[0][0].id).toBe('st-1');
  });

  it('AI 未配置：按钮置灰 + 顶部内联原因（入口不消失，不弹窗）', async () => {
    const onAiRetry = vi.fn();
    await render({ onAiRetry, aiReady: false, aiReason: '尚未配置 AI 服务地址（设置 → AI 服务）' });

    expect((container.querySelector('[data-testid="ai-retry-st-1"]') as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('[data-testid="ai-staging-blocked"]')?.textContent).toContain(
      '尚未配置 AI 服务地址',
    );

    await act(async () => {
      (container.querySelector('[data-testid="ai-retry-st-1"]') as HTMLButtonElement).click();
    });
    expect(onAiRetry).not.toHaveBeenCalled();
  });

  it('原文为空：按钮禁用（没有原文就没有可发的东西）', async () => {
    await render({ onAiRetry: vi.fn(), aiReady: true, items: [item({ rawSnippet: '', reason: 'unmapped' })] });
    const button = container.querySelector('[data-testid="ai-retry-st-1"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toContain('没有留下原文');
  });

  it('ambiguous / conflict 行不出现 AI 按钮（缺的是判断，不是认字）', async () => {
    await render({
      onAiRetry: vi.fn(),
      aiReady: true,
      items: [item({ reason: 'ambiguous', parsed: { companyName: '字节', jobTitle: '前端', confidence: {}, overall: 'low' } as unknown as StagedSyncItem['parsed'] })],
    });
    expect(container.querySelector('[data-testid="ai-retry-st-1"]')).toBeNull();
  });

  it('AI 补出公司名后（reason=unmapped）行内出现「归到某状态」通道', async () => {
    const onResolve = vi.fn();
    await render({
      onResolve,
      onAiRetry: vi.fn(),
      aiReady: true,
      items: [
        item({
          reason: 'unmapped',
          parsed: { companyName: '字节跳动', jobTitle: '前端实习生', confidence: {}, overall: 'low' } as unknown as StagedSyncItem['parsed'],
        }),
      ],
    });
    // 原文区不再是「没解析出来」的只读块，而是可归位的完整行
    expect(container.querySelector('.sync__staging-snippet')).toBeNull();
    expect(container.textContent).toContain('字节跳动');
    const resolve = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('确认归到'),
    ) as HTMLButtonElement;
    expect(resolve).toBeTruthy();

    await act(async () => {
      resolve.click();
    });
    expect(onResolve).toHaveBeenCalledWith('st-1', 'applied');
  });

  it('没有 onAiRetry 时不显示 AI 按钮（组件保持可被其它宿主复用）', async () => {
    await render({ aiReady: true });
    expect(container.querySelector('[data-testid="ai-retry-st-1"]')).toBeNull();
  });
});
