// @vitest-environment jsdom
/**
 * `App.tsx` 的**冒烟测试**（v0.9.2 · 清掉「全仓 3,380 行主组件零测试」这笔技术债）。
 *
 * ## 为什么是「冒烟」而不是「全量」
 *
 * App 是全部状态的聚合点：视图切换、快捷键、导入导出、文件联动、AI、撤销栈……
 * 给每一处都补交互测试等于把整个产品再测一遍，而大部分行为已经在各自的
 * lib / 组件测试里被守住了。这里只钉**只有 App 才能证明的四件事**：
 *
 * 1. 空环境首屏是欢迎页（不是白屏、不是崩溃页）；
 * 2. 点「加载示例数据看看」真的能把 8 家公司装进界面（api → state → 视图接线通）；
 * 3. 数据真的落进了 `localStorage`（刷新还能看见，不是内存幻觉）；
 * 4. 重新挂载后直接进主界面（欢迎页只在首次出现，不能每次都拦路）。
 *
 * ## 边界
 *
 * 不断言样式、不断言文案细节、不模拟真实用户长链路 —— 那些属于 CDP 冒烟
 * （`smoke-*.mjs`）与组件测试。这里的价值是：`App.tsx` 从此一旦在启动路径上
 * 崩溃（import 环、初始化顺序、空数据边界），`npm test` 就会红。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import App from './App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
/** vite `define` 注入的裸标识符，vitest 配置里没有 —— 与 SettingsDrawer 测试同规 */
(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ = '0.9.2';

const DB_KEY = 'jobdesk.v1';

/** 轮询等到条件成立（React 渲染不是同步的，固定 sleep 会偶发） */
async function waitFor(check: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    // 只让出事件循环，不套 act：外层 act 已经处理了事件引起的更新，
    // 这里再套一层会与 App 内部的 60s 心跳定时器相互等待（overlapping act）
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // 超时报错要能一眼看出「当时页面长什么样」，否则只能靠猜
  const snapshot = (document.body?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 300);
  throw new Error(`等待超时：${label} ｜ 当时页面：${snapshot}`);
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(text)) ?? null
  );
}

describe('App 冒烟（jsdom）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    container.remove();
    window.localStorage.clear();
  });

  async function mount(): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root?.render(<App />);
    });
  }

  it('★ 空环境首屏是欢迎页：两个入口都在（不是白屏 / 崩溃页）', async () => {
    await mount();

    await waitFor(() => container.querySelector('.welcome') !== null, '欢迎页渲染');
    expect(container.textContent).toContain('加载示例数据看看');
    expect(container.textContent).toContain('我要自己记第一家');
    // 崩溃兜底页绝不能出现
    expect(container.querySelector('.crash')).toBeNull();
  });

  it('★ 加载示例数据：8 家公司进看板，且真的写进了 localStorage', async () => {
    await mount();
    await waitFor(() => container.querySelector('.welcome') !== null, '欢迎页渲染');

    await act(async () => {
      buttonByText(container, '加载示例数据看看')?.click();
    });

    // 离开欢迎页 → 主界面出现
    await waitFor(() => container.querySelector('.welcome') === null, '离开欢迎页');
    expect(container.querySelector('.topbar')).not.toBeNull();

    // 切到看板，确认卡片真的渲染出来
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent?.trim() === '看板')
        ?.click();
    });
    // 看板的「已结束」列默认折叠：8 家里至少有 7 张可见卡（折叠本身是 v0.9.1 的设计）
    await waitFor(() => container.querySelectorAll('.app-card').length >= 7, '看板卡片渲染');
    expect(container.querySelectorAll('.app-card').length).toBeGreaterThanOrEqual(7);

    // 落盘证据：不是只活在 state 里 —— 总量必须是 8，不受折叠影响
    const raw = window.localStorage.getItem(DB_KEY);
    expect(raw).not.toBeNull();
    const saved = JSON.parse(raw as string) as { applications: unknown[] };
    expect(saved.applications).toHaveLength(8);
  }, 15000);

  it('★ 重新挂载（等价刷新）：直接进主界面，欢迎页不再拦路，数据还在', async () => {
    // 第一次：加载示例
    await mount();
    await waitFor(() => container.querySelector('.welcome') !== null, '首次欢迎页');
    await act(async () => {
      buttonByText(container, '加载示例数据看看')?.click();
    });
    await waitFor(() => container.querySelector('.welcome') === null, '首次离开欢迎页');

    // 卸载 = 关页面
    act(() => root?.unmount());
    root = null;

    // 第二次：同一份 localStorage 重新挂载
    await mount();
    await waitFor(() => container.querySelector('.topbar') !== null, '刷新后主界面');
    expect(container.querySelector('.welcome')).toBeNull();

    const raw = window.localStorage.getItem(DB_KEY);
    const saved = JSON.parse(raw as string) as { applications: unknown[] };
    expect(saved.applications).toHaveLength(8);
  });

  it('快捷键 2 能切到看板（键盘导航的接线没断）', async () => {
    await mount();
    await waitFor(() => container.querySelector('.welcome') !== null, '欢迎页渲染');
    await act(async () => {
      buttonByText(container, '加载示例数据看看')?.click();
    });
    await waitFor(() => container.querySelector('.welcome') === null, '离开欢迎页');

    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
    });

    await waitFor(() => container.querySelectorAll('.app-card').length > 0, '快捷键切看板');
  });
});
