// @vitest-environment jsdom
/**
 * VersionMenu（版本菜单）。
 *
 * 这一组守的是**用户数据的不可逆动作**：删除、覆盖草稿、满额。
 * 它们共同的特点是不报错、不崩溃，但做错了会在几周后才被发现
 * （「我当时投的那一版呢？」）。所以断言都落在「点了之后到底调了什么、文案说了什么」：
 * - 删除前必须出现「投递记录会保留」，且被引用时报出条数（A-12）；
 * - 以此版本为草稿是**覆盖**动作，必须二次确认（否则用户点一下就丢草稿）；
 * - 存新版本必须**先 flush 再 save**（顺序反了就会存下 400 ms 之前的旧内容）；
 * - 满额只提示不拦（Q12：第 28 个灰字，第 31 个才拒）。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppApi } from '../../lib/api';
import type { Resume, ResumeVersion } from '../../types';
import { VERSION_LIMIT } from '../../resume/versions';
import { VersionMenu } from './VersionMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RESUME: Resume = {
  id: 'res_1',
  name: '前端 - 主投',
  templateId: 'tech-single',
  content: { sections: [] },
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-01T00:00:00.000Z',
  deletedAt: null,
};

function version(id: string, label: string, extra: Partial<ResumeVersion> = {}): ResumeVersion {
  return {
    id,
    resumeId: RESUME.id,
    label,
    templateId: 'tech-single',
    content: { sections: [] },
    createdAt: '2026-03-01T00:00:00.000Z',
    deletedAt: null,
    ...extra,
  };
}

/** 只实现 VersionMenu 真正用到的那几个成员（其余一律不给 —— 用到就会炸，正好当护栏） */
function fakeApi(options: {
  versions?: ResumeVersion[];
  trashed?: ResumeVersion[];
  primaryId?: string | null;
  quota?: string | null;
  refs?: Record<string, number>;
  save?: AppApi['resume']['saveVersion'];
}): { api: AppApi; calls: string[] } {
  const calls: string[] = [];
  const record =
    <T,>(name: string, value: T) =>
    (...args: unknown[]): T => {
      calls.push(`${name}:${args.join(',')}`);
      return value;
    };

  const api = {
    resume: {
      versionsOf: () => options.versions ?? [],
      trashedVersionsOf: () => options.trashed ?? [],
      primaryVersionId: options.primaryId ?? null,
      quotaHint: () => options.quota ?? null,
      referencesOf: (id: string) => options.refs?.[id] ?? 0,
      saveVersion:
        options.save ??
        ((_id: string, label: string) => {
          calls.push(`save:${label}`);
          return { ok: true as const, id: 'ver_new', label: label || 'v9' };
        }),
      renameVersion: record('renameVersion', undefined),
      setPrimary: record('setPrimary', undefined),
      deleteVersion: record('deleteVersion', undefined),
      restoreVersion: record('restoreVersion', undefined),
      purgeVersion: record('purgeVersion', undefined),
      adoptAsDraft: record('adoptAsDraft', undefined),
    },
  } as unknown as AppApi;

  return { api, calls };
}

describe('VersionMenu（jsdom）', () => {
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

  async function render(api: AppApi, onBeforeSave = (): void => undefined): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root.render(<VersionMenu api={api} resume={RESUME} onBeforeSave={onBeforeSave} />);
    });
  }

  const button = (text: string): HTMLButtonElement | undefined =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (item) => item.textContent?.trim() === text,
    );

  it('空态：说明「先存一版」，不是一片空白', async () => {
    const { api } = fakeApi({});
    await render(api);
    expect(container.querySelector('.ver-menu__empty')?.textContent).toContain('还没有版本');
    expect(container.querySelectorAll('.ver-item')).toHaveLength(0);
  });

  it('★ 存新版本：先 flush 再 save（顺序反了会存下 400 ms 之前的内容）', async () => {
    const order: string[] = [];
    const { api } = fakeApi({
      save: (_id, label) => {
        order.push(`save:${label}`);
        return { ok: true, id: 'ver_new', label: label || 'v9' };
      },
    });
    await render(api, () => order.push('flush'));

    const input = container.querySelector<HTMLInputElement>('.ver-menu__save input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'v1 投出去的那版');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('存为新版本')!.click());

    expect(order).toEqual(['flush', 'save:v1 投出去的那版']);
  });

  it('存成功清空输入；存失败显示原因且不清空（满额是可重试的）', async () => {
    const { api } = fakeApi({ save: () => ({ ok: false, reason: '版本已满 30 个 —— 先删旧版本' }) });
    await render(api);
    const input = container.querySelector<HTMLInputElement>('.ver-menu__save input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'v9');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('存为新版本')!.click());

    expect(container.querySelector('.field__hint--danger')?.textContent).toContain('版本已满');
    expect(input.value).toBe('v9');
  });

  it('★ Q12：满额灰字只在 api 说「接近上限」时出现（第 28 个起）', async () => {
    const { api } = fakeApi({ quota: `已 28/${VERSION_LIMIT}，满了需要先删旧版本` });
    await render(api);
    expect(container.querySelector('.ver-menu__quota')?.textContent).toContain(`已 28/${VERSION_LIMIT}`);

    const quiet = fakeApi({});
    await act(async () => {
      root.render(<VersionMenu api={quiet.api} resume={RESUME} onBeforeSave={() => undefined} />);
    });
    expect(container.querySelector('.ver-menu__quota')).toBeNull();
  });

  it('★ 删除被引用的版本：先说「投递记录会保留」，再报条数，确认后才删', async () => {
    const { api, calls } = fakeApi({ versions: [version('ver_1', 'v1 前端')], refs: { ver_1: 3 } });
    await render(api);

    await act(async () => button('删除')!.click());
    const confirm = container.querySelector('.ver-item__confirm')!;
    expect(confirm.textContent).toContain('投递记录会保留');
    expect(confirm.textContent).toContain('v1 前端（已删除）');
    expect(confirm.textContent).toContain('有 3 条投递');
    // 还没点确认 —— 一个字节都不许删
    expect(calls).toEqual([]);

    await act(async () => button('确认删除')!.click());
    expect(calls).toEqual(['deleteVersion:ver_1']);
  });

  it('删除没被引用的版本也要说清楚「没有投递绑在这一版上」', async () => {
    const { api } = fakeApi({ versions: [version('ver_1', 'v1')] });
    await render(api);
    await act(async () => button('删除')!.click());
    expect(container.querySelector('.ver-item__confirm')!.textContent).toContain('没有投递绑在这一版上');
  });

  it('★ 以此版本为草稿 = 覆盖草稿，必须二次确认（点一下不能就丢）', async () => {
    const { api, calls } = fakeApi({ versions: [version('ver_1', 'v1')] });
    await render(api);

    await act(async () => button('以此版本为草稿')!.click());
    const confirm = container.querySelector('.ver-item__confirm')!;
    expect(confirm.textContent).toContain('当前草稿里没存版本的内容会丢');
    expect(calls).toEqual([]);

    await act(async () => button('确认覆盖草稿')!.click());
    expect(calls).toEqual(['adoptAsDraft:ver_1']);
  });

  it('取消二次确认 → 什么都不发生', async () => {
    const { api, calls } = fakeApi({ versions: [version('ver_1', 'v1')] });
    await render(api);
    await act(async () => button('删除')!.click());
    await act(async () => button('取消')!.click());
    expect(calls).toEqual([]);
    expect(container.querySelector('.ver-item__confirm')).toBeNull();
  });

  it('主版本：亮徽标、且「设为主版本」不可再点（已是主版本）', async () => {
    const { api } = fakeApi({ versions: [version('ver_1', 'v1')], primaryId: 'ver_1' });
    await render(api);
    expect(container.querySelector('.ver-item__badge')?.textContent).toBe('主版本');
    expect(button('设为主版本')!.disabled).toBe(true);
  });

  it('重命名：Enter 提交，空名也照样提交（由 api 侧决定不算改动）', async () => {
    const { api, calls } = fakeApi({ versions: [version('ver_1', 'v1')] });
    await render(api);

    await act(async () => button('重命名')!.click());
    const input = container.querySelector<HTMLInputElement>('.ver-item input')!;
    expect(input.value).toBe('v1');

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'v1 项目版');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('保存')!.click());
    expect(calls).toEqual(['renameVersion:ver_1,v1 项目版']);
  });

  it('★ 回收站折叠：默认收起，展开后能恢复 / 永久删除', async () => {
    const { api, calls } = fakeApi({
      versions: [version('ver_1', 'v1')],
      trashed: [version('ver_2', 'v2', { deletedAt: '2026-03-05T00:00:00.000Z' })],
    });
    await render(api);

    expect(container.querySelector('.ver-list--trash')).toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>('.ver-trash__toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => toggle.click());

    expect(container.querySelector('.ver-list--trash')?.textContent).toContain('v2');
    await act(async () => button('恢复')!.click());
    await act(async () => button('永久删除')!.click());
    expect(calls).toEqual(['restoreVersion:ver_2', 'purgeVersion:ver_2']);
  });

  it('版本按 api 给的顺序渲染（新的在前由 api 负责，组件不再排序）', async () => {
    const { api } = fakeApi({
      versions: [version('ver_2', 'v2 新的'), version('ver_1', 'v1 旧的')],
    });
    await render(api);
    const labels = Array.from(container.querySelectorAll('.ver-item__label')).map((el) => el.textContent);
    expect(labels).toEqual(['v2 新的', 'v1 旧的']);
  });

  it('版本数与回收站条数写在标题行（不用展开就知道有几条）', async () => {
    const { api } = fakeApi({
      versions: [version('ver_1', 'v1')],
      trashed: [version('ver_2', 'v2', { deletedAt: '2026-03-05T00:00:00.000Z' })],
    });
    await render(api);
    expect(container.querySelector('.ver-menu__count')?.textContent).toContain('1 个');
    expect(container.querySelector('.ver-menu__count')?.textContent).toContain('回收站 1');
  });

  it('saveVersion 由 api 兜底：调用参数就是输入框里的名字', async () => {
    const save = vi.fn(() => ({ ok: true as const, id: 'ver_new', label: 'v5 定向版' }));
    const { api } = fakeApi({ save });
    await render(api);
    const input = container.querySelector<HTMLInputElement>('.ver-menu__save input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'v5 定向版');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('存为新版本')!.click());
    expect(save).toHaveBeenCalledWith(RESUME.id, 'v5 定向版');
    expect(input.value).toBe('');
  });
});
