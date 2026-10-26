// @vitest-environment jsdom
/**
 * 设置 → 回收站的「简历」子区（v0.9.1 / R-RES-10 的 UI 侧）。
 *
 * 这一组守三件事：
 * 1. **空态不渲染**：没有已删简历时不能出现「简历（0 份）」—— 空壳比没有更让人困惑；
 * 2. **三件套都真的接到了 api**：恢复 / 再留 7 天 / 永久删除（永久删除必须两步，
 *    这一步防的是「一次误点就永久删掉一份简历」）；
 * 3. **版本计数只在有已删版本时出现**：`含 N 个已删版本` 是线索，不是噪音。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppApi } from '../../lib/api';
import type { DB, Resume } from '../../types';
import { emptyDB } from '../../lib/defaults';
import { ResumeTrashSection } from './ResumeTrashSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 固定「现在」：天数断言不能跟着真实时钟漂 */
const NOW = new Date('2026-03-10T00:00:00.000Z');
/** 删除时间：已过 10 天 → 30 天保留期还剩 20 天 */
const DELETED = '2026-02-28T00:00:00.000Z';
/** 快到期：已过 27 天 → 还剩 3 天（≤3 触发到期告警） */
const DELETED_URGENT = '2026-02-11T00:00:00.000Z';

function makeResume(id: string, name: string, deletedAt: string | null = DELETED): Resume {
  return {
    id,
    name,
    templateId: 'tech-single',
    content: { sections: [] } as unknown as Resume['content'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt,
  };
}

/**
 * 只给这个组件真正用到的成员（用到没给的就会炸，正好当护栏）。
 * ★ 手写部分对象 + `as unknown as AppApi`：TS 拦不住，所以成员必须手动跟上。
 */
function makeApi(options: {
  trashed: Resume[];
  trashedVersions?: number;
}): {
  api: AppApi;
  restore: ReturnType<typeof vi.fn>;
  purge: ReturnType<typeof vi.fn>;
  extend: ReturnType<typeof vi.fn>;
} {
  const db: DB = emptyDB();
  const restore = vi.fn();
  const purge = vi.fn();
  const extend = vi.fn();
  const api = {
    db,
    now: NOW,
    resume: {
      trashed: options.trashed,
      trashedVersionsOf: () => Array.from({ length: options.trashedVersions ?? 0 }, (_, i) => `ver-${i}`),
      restore,
      purge,
      extendTrash: extend,
    },
  } as unknown as AppApi;
  return { api, restore, purge, extend };
}

describe('ResumeTrashSection（jsdom）', () => {
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

  async function render(api: AppApi): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root.render(<ResumeTrashSection api={api} />);
    });
  }

  const button = (text: string): HTMLButtonElement => {
    const found = Array.from(container.querySelectorAll('button')).find((item) =>
      item.textContent?.includes(text),
    );
    if (!found) throw new Error(`找不到按钮：${text}`);
    return found;
  };

  it('★ 没有已删简历 → 整段不渲染（不能出现「简历（0 份）」这种空壳）', async () => {
    const { api } = makeApi({ trashed: [] });
    await render(api);
    expect(container.innerHTML).toBe('');
  });

  it('★ 有已删简历 → 标题带份数、名字、剩余天数、三个入口都在', async () => {
    const { api } = makeApi({ trashed: [makeResume('res-1', '前端 - 主投')] });
    await render(api);

    expect(container.textContent).toContain('简历（1 份）');
    expect(container.textContent).toContain('前端 - 主投');
    expect(container.textContent).toContain('还剩 20 天');
    expect(button('恢复')).toBeTruthy();
    expect(button('再留 7 天')).toBeTruthy();
    expect(button('永久删除')).toBeTruthy();
    // 说清「恢复会把版本一起带回来」，以及「只想找回某个版本去哪」
    expect(container.textContent).toContain('恢复时它下面的版本一并回来');
    expect(container.textContent).toContain('版本菜单');
  });

  it('剩余 ≤ 3 天 → 行加到期告警样式（复用投递回收站的 trash-row--expiring）', async () => {
    const { api } = makeApi({ trashed: [makeResume('res-1', '快到期', DELETED_URGENT)] });
    await render(api);
    expect(container.querySelector('.trash-row--expiring')).not.toBeNull();
    expect(container.textContent).toContain('还剩 3 天');
  });

  it('★ 「再留 7 天」直接调 api.resume.extendTrash（一次点击一次写库）', async () => {
    const { api, extend } = makeApi({ trashed: [makeResume('res-1', '前端 - 主投')] });
    await render(api);
    await act(async () => button('再留 7 天').click());
    expect(extend).toHaveBeenCalledWith('res-1');
  });

  it('★ 「恢复」调 api.resume.restore', async () => {
    const { api, restore } = makeApi({ trashed: [makeResume('res-1', '前端 - 主投')] });
    await render(api);
    await act(async () => button('恢复').click());
    expect(restore).toHaveBeenCalledWith('res-1');
  });

  it('★ 永久删除必须两步：第一次点只出确认，不调 purge；确认后才真删', async () => {
    const { api, purge } = makeApi({ trashed: [makeResume('res-1', '前端 - 主投')] });
    await render(api);

    await act(async () => button('永久删除').click());
    expect(purge).not.toHaveBeenCalled();
    expect(container.textContent).toContain('确认永久删除');

    await act(async () => button('确认永久删除').click());
    expect(purge).toHaveBeenCalledWith('res-1');
  });

  it('取消永久删除 → 回到未确认状态，purge 一次都没调', async () => {
    const { api, purge } = makeApi({ trashed: [makeResume('res-1', '前端 - 主投')] });
    await render(api);

    await act(async () => button('永久删除').click());
    await act(async () => button('取消').click());
    expect(purge).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('确认永久删除');
  });

  it('有已删版本时行内显示「含 N 个已删版本」，没有时不显示这句', async () => {
    const withVersions = makeApi({ trashed: [makeResume('res-1', '主投')], trashedVersions: 2 });
    await render(withVersions.api);
    expect(container.textContent).toContain('含 2 个已删版本');

    act(() => root.unmount());
    container.innerHTML = '';

    const withoutVersions = makeApi({ trashed: [makeResume('res-1', '主投')], trashedVersions: 0 });
    await render(withoutVersions.api);
    expect(container.textContent).not.toContain('已删版本');
  });
});
