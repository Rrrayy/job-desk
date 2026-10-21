// @vitest-environment jsdom
/**
 * ErrorBoundary 组件测试（v0.5.1 起组件测试破例引入 jsdom，环境用文件级 docblock 声明）。
 *
 * 为什么第一个组件测试选它：这条是 v0.4.1 的产品语义红线 ——
 * 崩溃兜底**只给出口**（重载 / 下载原文 / 复制错误），绝不写 key、绝不自动修复。
 * 以前这条语义只有人工 review 把关，现在有机器守着。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

/** 测试里必炸的子组件 */
function Bomb(): never {
  throw new Error('测试爆炸');
}

const KEY = 'jobdesk.v1';

describe('ErrorBoundary（jsdom）', () => {
  let container: HTMLDivElement;
  let root: Root;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // 崩溃时会 console.error 堆栈，测试输出不必看这个
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('__APP_VERSION__', '0.5.1');
    container = document.createElement('div');
    document.body.appendChild(container);
    localStorage.setItem(KEY, '{"sentinel":true}');
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    consoleSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('正常时不拦截，崩溃后展示兜底页与三个出口', async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <ErrorBoundary>
          <p>正常内容</p>
        </ErrorBoundary>,
      );
    });
    expect(container.textContent).toContain('正常内容');

    await act(async () => {
      root.render(
        <ErrorBoundary>
          <Bomb />
        </ErrorBoundary>,
      );
    });
    const text = container.textContent ?? '';
    expect(text).toContain('你的数据还在');
    expect(text).toContain('测试爆炸');
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toEqual(['重新加载', '下载原始数据', '复制错误信息']);
  });

  it('崩溃时一个字节都不写 localStorage（绝不自动修复）', async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <ErrorBoundary>
          <Bomb />
        </ErrorBoundary>,
      );
    });
    expect(localStorage.getItem(KEY)).toBe('{"sentinel":true}');
    // 除了哨兵，不允许出现任何新 key
    expect(localStorage.length).toBe(1);
  });
});
