// @vitest-environment jsdom
/**
 * `SettingsDrawer` 的**薄挂载**断言（v0.9.1 / T5 收尾，主理人点名要的那一条）。
 *
 * ## 为什么需要这一条
 *
 * `ResumeTrashSection` 自己有 8 条测试、把三件套接到了哪个 api 都钉住了 ——
 * 但那些测试是**直接渲染 `ResumeTrashSection`**。如果它从来没被挂进设置页，
 * 用户依然找不到「回收站里能找回简历」这个能力，而所有测试照样全绿。
 *
 * 这类「组件对了但没接线」的缺口只能靠**从父级往下渲染一次**来堵。
 *
 * ## 为什么只写「薄」挂载
 *
 * 这里刻意只断言**存在性**（`.resume-trash__title` 在不在），不重复断言子区内部行为 ——
 * 那 8 条测试已经把细节守住了。多写一遍只会让两处断言随实现漂移，
 * 反而降低维护性（与 Q1「门禁/工具的可维护性优先于严格度」同一取向）。
 *
 * ## mock 的成本
 *
 * `SettingsDrawer` 是个聚合容器（数据 / 平台同步 / 题库 / 文件联动 / AI / 插件 / 存储 / 关于），
 * 所以 `api` 的手写桩要覆盖 5 个子组件挂载时读到的成员。这是**一次性的固定成本**，
 * 换来「这些子区到底有没有被挂上」这件事从此有自动化证据。
 * 桩里**故意只给挂载期真正读到的成员**：漏给就会当场炸，正好当护栏。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppApi } from '../lib/api';
import type { DB, Resume } from '../types';
import { emptyDB } from '../lib/defaults';
import { SettingsDrawer } from './SettingsDrawer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
/**
 * `__APP_VERSION__` 是 vite 构建期注入的裸标识符（`vite.config.ts` 的 `define`）。
 * vitest 走的是**另一份** `vitest.config.ts`（架构 D-04：测试配置独立），那份没有 define，
 * 所以这里把版本号挂到 `globalThis` 上 —— 否则「关于」里的 `v{__APP_VERSION__}` 会 ReferenceError。
 */
(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ = '0.9.1';

/** 固定「现在」：剩余天数断言不能跟着真实时钟漂 */
const NOW = new Date('2026-03-10T00:00:00.000Z');
/** 已删 10 天 → 30 天保留期还剩 20 天 */
const DELETED = '2026-02-28T00:00:00.000Z';

function makeResume(id: string, name: string): Resume {
  return {
    id,
    name,
    templateId: 'tech-single',
    content: { sections: [] } as unknown as Resume['content'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: DELETED,
  };
}

/**
 * 只给挂载期真正读到的成员。
 *
 * ★ 手写部分对象 + `as unknown as AppApi`：TypeScript 拦不住「少给了一个成员」，
 *   所以这里成员表必须手动跟上 `AppApi` 的演进（与 `ResumeTrashSection.test.tsx` 同规）。
 */
function makeApi(trashed: Resume[]): AppApi {
  const db: DB = emptyDB();
  const api = {
    db,
    now: NOW,
    /** 挂载期读一次：显示「数据存在这个浏览器里…当前用 X」 */
    storageBackend: () => 'localStorage',
    /** 挂载期 `useEffect` 里 promise 一次：显示已用 / 可用 */
    checkStorage: () => Promise.resolve({ usage: 1024, quota: 5 * 1024 * 1024, ratio: 0.0002 }),
    updateSettings: vi.fn(),
    /** 题库子区挂载期读 `api.db.experiences`，不需要额外成员 */
    importCommunityFile: vi.fn(),
    /** AI 子区挂载期读 `api.ai.ready` / `api.ai.readyReason` */
    ai: { ready: false, readyReason: '未配置', clearRequestLog: vi.fn() },
    /** 文件联动子区：全部走 props，这里提供挂载期读到的能力位 */
    fileLink: {
      capability: 'unsupported' as const,
      fileName: null,
      readOnlyMessage: null,
      hasPending: false,
      busy: false,
    },
    /** 插件子区：空列表即可（有插件时的渲染不在这条断言的范围里） */
    plugins: { list: () => [] },
    /** ★ 被断言的主角：简历回收站子区读 `api.resume.trashed` / `api.now` */
    resume: {
      trashed,
      trashedVersionsOf: () => [],
      restore: vi.fn(),
      purge: vi.fn(),
      extendTrash: vi.fn(),
    },
  } as unknown as AppApi;
  return api;
}

describe('SettingsDrawer 薄挂载（jsdom）', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    // storage 里有 jest/vitest 之间的残留（最近导出时间、回滚点），清掉保证用例互不影响
    window.localStorage.clear();
  });

  async function render(api: AppApi): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <SettingsDrawer
          api={api}
          onClose={() => {}}
          importError={null}
          onDismissError={() => {}}
          trashed={[]}
        />,
      );
    });
  }

  it('★ 有已删简历时，「简历（N 份）」子区真的出现在设置页里（不是只有组件自测绿）', async () => {
    await render(makeApi([makeResume('res-1', '前端 - 主投')]));

    const title = container.querySelector('.resume-trash__title');
    expect(title).not.toBeNull();
    expect(title?.textContent).toBe('简历（1 份）');
    // 光有标题不够：入口按钮必须在同一棵子树里，用户才点得到
    expect(container.textContent).toContain('再留 7 天');
    expect(container.textContent).toContain('恢复时它下面的版本一并回来');
  });

  it('没有已删简历时，设置页里不出现这个子区（空壳比没有更让人困惑）', async () => {
    await render(makeApi([]));
    expect(container.querySelector('.resume-trash__title')).toBeNull();
    // 设置页本体仍然在渲染 —— 否则上一条的「不存在」可能只是因为整页没渲染出来
    expect(container.querySelector('.drawer--settings')).not.toBeNull();
  });
});
