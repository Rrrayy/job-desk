// @vitest-environment jsdom
/**
 * 打印入口 + 提示层（v0.9.1 / R-PRT-1 的 UI 侧）。
 *
 * 这里只验三件事（版式与编排在别处）：
 * 1. 打开提示层 → 出现浏览器专属的那一句（`.print-hint__ua`），**基础两句仍在**；
 * 2. 认不出浏览器 → 整行不渲染（不留一个空段落占位）；
 * 3. `Esc` 关掉提示层后焦点回到打印按钮（A11y：键盘用户不能掉到页面顶部）。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrintButton } from './PrintButton';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UA = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0',
  jsdom: 'Mozilla/5.0 (linux) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/30.1.3',
} as const;

describe('PrintButton 提示层（jsdom）', () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalUa = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');

  function setUa(value: string): void {
    Object.defineProperty(window.navigator, 'userAgent', { value, configurable: true });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    // 打印编排在别处测；这里禁掉真实 print（jsdom 里它不存在，但仍要断言没被误调）
    vi.spyOn(window, 'print').mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    if (originalUa) Object.defineProperty(window.navigator, 'userAgent', originalUa);
  });

  async function openHint(): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root.render(<PrintButton />);
    });
    const trigger = Array.from(container.querySelectorAll('button')).find((item) =>
      item.textContent?.includes('打印'),
    )!;
    await act(async () => trigger.click());
  }

  it('★ Chrome：提示层里多一行 Chrome/Edge 专属说明，基础两句都在', async () => {
    setUa(UA.chrome);
    await openHint();

    expect(container.querySelector('.print-hint')).not.toBeNull();
    const ua = container.querySelector('.print-hint__ua');
    expect(ua).not.toBeNull();
    expect(ua?.textContent).toContain('Chrome / Edge');
    expect(ua?.textContent).toContain('另存为 PDF');
    // 基础两句仍然渲染（UA 只加一句，不替换）
    expect(container.querySelectorAll('.print-hint__list li')).toHaveLength(2);
  });

  it('★ Firefox：那一行点明「缩放选 100%」', async () => {
    setUa(UA.firefox);
    await openHint();
    expect(container.querySelector('.print-hint__ua')?.textContent).toContain('100%');
  });

  it('认不出浏览器（jsdom 自己的 UA）→ 不渲染空行', async () => {
    setUa(UA.jsdom);
    await openHint();
    expect(container.querySelector('.print-hint')).not.toBeNull();
    expect(container.querySelector('.print-hint__ua')).toBeNull();
  });

  it('Esc 关闭后焦点回到打印按钮（不掉到页面顶部）', async () => {
    setUa(UA.chrome);
    await openHint();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container.querySelector('.print-hint')).toBeNull();
    expect(document.activeElement?.textContent).toContain('打印');
  });
});
