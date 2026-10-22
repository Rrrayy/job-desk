// @vitest-environment jsdom
/**
 * PluginsPanel 组件测试（v0.8 / T04）：列表/启停/逐项授权/卸载/日志文本。
 * 裸 react-dom + act 模式；协议与存储在 broker/storage 单测覆盖。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginsPanel } from './PluginsPanel';
import type { PluginRegistration } from '../../plugins/types';

const REGISTRATION: PluginRegistration = {
  pluginId: 'plugin:demo',
  name: 'Demo 插件',
  version: '1.2.3',
  permissions: ['storage', 'network:demo', 'suggest:application_note'],
  enabled: false,
  granted: [],
};

const LOGS = [
  { timestamp: '2026-10-21T10:00:00.000Z', pluginId: 'plugin:demo', model: 'qwen', status: 'ok' },
  { timestamp: '2026-10-21T10:05:00.000Z', pluginId: 'plugin:demo', model: 'qwen', status: 'error', errorCode: 'field_mismatch' },
];

describe('PluginsPanel', () => {
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

  async function renderPanel(
    plugins: PluginRegistration[],
    logs: typeof LOGS = [],
  ): Promise<Record<string, ReturnType<typeof vi.fn>>> {
    const handlers = {
      onEnable: vi.fn(),
      onGrant: vi.fn(),
      onUninstall: vi.fn(),
      onLoadFile: vi.fn(async () => null),
    };
    root = createRoot(container);
    await act(async () => {
      root.render(
        <PluginsPanel
          plugins={plugins}
          onEnable={handlers.onEnable}
          onGrant={handlers.onGrant}
          onUninstall={handlers.onUninstall}
          onLoadFile={handlers.onLoadFile}
          requestLogs={logs}
        />,
      );
    });
    return handlers;
  }

  const buttonByText = (text: string): HTMLButtonElement | undefined =>
    Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes(text));

  it('空列表给空态与加载入口提示', async () => {
    await renderPanel([]);
    expect(container.querySelector('[data-testid="plugins-empty"]')?.textContent).toContain('还没有安装插件');
  });

  it('渲染插件行：名称/版本/权限逐项（未授权默认不勾）', async () => {
    await renderPanel([REGISTRATION]);
    const row = container.querySelector('[data-testid="plugin-plugin:demo"]');
    expect(row?.textContent).toContain('Demo 插件');
    expect(row?.textContent).toContain('v1.2.3');
    expect(row?.textContent).toContain('AI 请求 · demo');
    // 三项权限的勾选框都在（data-testid 按 pluginId+权限串定位）
    expect(container.querySelector('[data-testid="plugin-perm-plugin:demo-storage"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="plugin-perm-plugin:demo-network:demo"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="plugin-perm-plugin:demo-suggest:application_note"]')).not.toBeNull();
    const boxes = row?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    // 启用 + 3 项权限 = 4 个勾选框，全部未勾
    expect(boxes?.length).toBe(4);
    expect(Array.from(boxes ?? []).every((box) => !box.checked)).toBe(true);
  });

  it('启停 / 授权 / 卸载回调参数正确', async () => {
    const handlers = await renderPanel([REGISTRATION]);
    await act(async () => {
      container.querySelector<HTMLInputElement>('[data-testid="plugin-enable-plugin:demo"]')?.click();
    });
    expect(handlers.onEnable).toHaveBeenCalledWith('plugin:demo', true);

    await act(async () => {
      container
        .querySelector<HTMLInputElement>('[data-testid="plugin-perm-plugin:demo-network:demo"]')
        ?.click();
    });
    expect(handlers.onGrant).toHaveBeenCalledWith('plugin:demo', 'network:demo', true);

    await act(async () => {
      buttonByText('卸载')?.click();
    });
    expect(handlers.onUninstall).toHaveBeenCalledWith('plugin:demo');
  });

  it('请求日志按插件过滤的文本列表（无原文，只有元数据）', async () => {
    await renderPanel([REGISTRATION], LOGS);
    expect(container.textContent).not.toContain('2026-10-21');
    await act(async () => {
      buttonByText('看请求日志')?.click();
    });
    const logs = container.querySelector('[data-testid="plugin-logs-plugin:demo"]');
    expect(logs?.textContent).toContain('ok');
    expect(logs?.textContent).toContain('field_mismatch');
    expect(logs?.textContent).toContain('qwen');
    expect(logs?.textContent).not.toContain('{{field:');
  });

  it('加载失败显示错误文案', async () => {
    const handlers = await renderPanel([]);
    handlers.onLoadFile.mockResolvedValueOnce('manifest 不是合法 JSON');
    const input = container.querySelector<HTMLInputElement>('[data-testid="plugin-file-input"]');
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [new File(['x'], 'p.html')] });
      input?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="plugin-load-error"]')?.textContent).toContain('manifest 不是合法 JSON');
  });
});
