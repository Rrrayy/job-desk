// @vitest-environment jsdom
/**
 * ResumeView（简历一级页）—— 列表态 ⇄ 编辑态。
 *
 * 这一组守的是**接线**，不是版式（版式在真浏览器里，见 smoke-print）：
 * - 打开哪份简历是唯一的 UI 状态，删掉正在编辑的那份要自动退回列表；
 * - 编辑器三栏（模板 / 表单 / 预览）确实挂的是真组件，预览画的是**本地草稿**；
 * - 打印入口在工具条上（22.8 KB 的 print/A4 代码由这一行激活）；
 * - 切模板**先 flush 再改**（顺序反了会丢最后 400 ms 的输入）。
 *
 * 用一个只有必要成员的假 api：多给一个成员就等于允许组件偷偷多调一次。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppApi } from '../../lib/api';
import type { Resume, ResumeVersion } from '../../types';
import { emptyContentOf } from '../../resume/schema';
import { ResumeView } from './ResumeView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function resume(id: string, name: string, templateId: Resume['templateId'] = 'tech-single'): Resume {
  return {
    id,
    name,
    templateId,
    content: emptyContentOf(templateId),
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    deletedAt: null,
  };
}

interface FakeOptions {
  list?: Resume[];
  trashed?: Resume[];
  openedId?: string | null;
  versions?: ResumeVersion[];
}

/** 记录调用顺序的假 api（顺序本身也是被测对象：flush 必须在 setTemplate 之前） */
function fakeApi(options: FakeOptions = {}): { api: AppApi; calls: string[] } {
  const calls: string[] = [];
  const noop = (name: string) => (...args: unknown[]) => {
    // 无参调用记成 `close` 而不是 `close:` —— 「有没有传参」本身就是断言对象
    calls.push(args.length > 0 ? `${name}:${args.join(',')}` : name);
  };

  const api = {
    /** T06 起 ResumeList 会从 `api.db` 里读统计（buildResumeStats 需要 interviews/applications） */
    db: {
      interviews: [],
      applications: [],
      resumeVersions: options.versions ?? [],
    },
    updateResumeContent: (...args: unknown[]) => {
      calls.push(`commit:${String(args[0])}`);
    },
    resume: {
      list: options.list ?? [],
      trashed: options.trashed ?? [],
      openedId: options.openedId ?? null,
      open: noop('open'),
      close: noop('close'),
      create: (input: { name: string; templateId: string }) => {
        calls.push(`create:${input.name},${input.templateId}`);
        return 'res_new';
      },
      duplicate: (id: string) => {
        calls.push(`duplicate:${id}`);
        return 'res_copy';
      },
      rename: noop('rename'),
      setTemplate: (id: string, templateId: string) => {
        calls.push(`setTemplate:${id},${templateId}`);
      },
      softDelete: noop('softDelete'),
      restore: noop('restore'),
      purge: noop('purge'),
      versionsOf: () => options.versions ?? [],
      trashedVersionsOf: () => [],
      quotaHint: () => null,
      saveVersion: () => ({ ok: true as const, id: 'ver_new', label: 'v1' }),
      renameVersion: noop('renameVersion'),
      setPrimary: noop('setPrimary'),
      deleteVersion: noop('deleteVersion'),
      restoreVersion: noop('restoreVersion'),
      purgeVersion: noop('purgeVersion'),
      adoptAsDraft: noop('adoptAsDraft'),
      referencesOf: () => 0,
      primaryVersionId: null,
    },
  } as unknown as AppApi;

  return { api, calls };
}

describe('ResumeView（jsdom）', () => {
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
      root.render(<ResumeView api={api} />);
    });
  }

  const button = (text: string): HTMLButtonElement | undefined =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (item) => item.textContent?.trim() === text,
    );

  const setInput = async (input: HTMLInputElement, value: string): Promise<void> => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  it('列表态：名字、模板、版本数、空态文案', async () => {
    const { api } = fakeApi({ list: [resume('res_1', '前端 - 主投')] });
    await render(api);

    expect(container.querySelector('.resume-home__title')?.textContent).toBe('简历');
    expect(container.querySelector('.resume-row__name')?.textContent).toBe('前端 - 主投');
    expect(container.querySelector('.resume-row__meta')?.textContent).toContain('0 个版本');
    // 空态只在真的没有简历时出现
    expect(container.querySelector('.resume-home__empty')).toBeNull();
  });

  it('列表为空 → 说「先建一份」，而不是一片空白', async () => {
    const { api } = fakeApi({});
    await render(api);
    expect(container.querySelector('.resume-home__empty')?.textContent).toContain('还没有简历');
  });

  it('点名字 / 点打开都只做一件事：open(id)', async () => {
    const { api, calls } = fakeApi({ list: [resume('res_1', 'A')] });
    await render(api);

    await act(async () => container.querySelector<HTMLButtonElement>('.resume-row__name')!.click());
    await act(async () => button('打开')!.click());
    expect(calls).toEqual(['open:res_1', 'open:res_1']);
  });

  it('★ 新建：名字与模板一起交给 api.create，然后直接进编辑器', async () => {
    const { api, calls } = fakeApi({});
    await render(api);

    await act(async () => button('＋ 新建简历')!.click());
    await setInput(container.querySelector<HTMLInputElement>('input[aria-label="简历名字"]')!, '后端 - 主投');
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="模板"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, 'academic');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => button('创建')!.click());

    expect(calls).toEqual(['create:后端 - 主投,academic', 'open:res_new']);
  });

  it('复制 / 删除都走 api（副本打开、原件进回收站）', async () => {
    const { api, calls } = fakeApi({ list: [resume('res_1', 'A')] });
    await render(api);
    await act(async () => button('复制')!.click());
    await act(async () => button('删除')!.click());
    expect(calls).toEqual(['duplicate:res_1', 'open:res_copy', 'softDelete:res_1']);
  });

  it('回收站折叠：默认收起，展开后恢复 / 永久删除', async () => {
    const { api, calls } = fakeApi({
      trashed: [{ ...resume('res_9', '删掉的'), deletedAt: '2026-03-05T00:00:00.000Z' }],
    });
    await render(api);

    expect(container.querySelector('.resume-rows--trash')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('.res-trash__toggle')!.click());
    await act(async () => button('恢复')!.click());
    await act(async () => button('永久删除')!.click());
    expect(calls).toEqual(['restore:res_9', 'purge:res_9']);
  });

  it('★ 编辑态：三栏都是真组件 —— 模板选择器 / 表单 / A4 纸', async () => {
    const { api } = fakeApi({ list: [resume('res_1', 'A')], openedId: 'res_1' });
    await render(api);

    expect(container.querySelectorAll('.tpl-card')).toHaveLength(8);
    expect(container.querySelector('.resume-form')).not.toBeNull();
    expect(container.querySelector('.a4 .a4__body')).not.toBeNull();
    // 预览画的是草稿，草稿为空 → 只有必填占位，但板块结构必须在（不是一张白纸）
    expect(container.querySelectorAll('.rs-section').length).toBeGreaterThan(0);
  });

  it('★ 打印入口挂在工具条上，且点开有提示层（PRD §9-4）', async () => {
    const { api } = fakeApi({ list: [resume('res_1', 'A')], openedId: 'res_1' });
    await render(api);

    const entry = container.querySelector('.resume-editor__acts .print-entry');
    expect(entry).not.toBeNull();
    await act(async () => button('打印 / 存为 PDF')!.click());
    expect(container.querySelector('.print-hint')).not.toBeNull();
  });

  it('★ 编辑态：版本菜单在同一页（不用来回跳就能存版本）', async () => {
    const { api } = fakeApi({ list: [resume('res_1', 'A')], openedId: 'res_1' });
    await render(api);
    expect(container.querySelector('.ver-menu')).not.toBeNull();
  });

  it('★ 切模板先 flush 再改：最后 400 ms 的输入不会被覆盖掉', async () => {
    const { api, calls } = fakeApi({ list: [resume('res_1', 'A')], openedId: 'res_1' });
    await render(api);

    // 在表单里改一个字（进防抖窗口，还没落库）
    const input = container.querySelector<HTMLInputElement>('.resume-form input.input')!;
    await setInput(input, '林一舟');
    const cards = container.querySelectorAll<HTMLButtonElement>('.tpl-card');
    await act(async () => cards[3].click());

    // 顺序：先 commit（flush 把草稿写掉），再 setTemplate —— 反了就是「我明明写了」
    expect(calls).toEqual(['commit:res_1', 'setTemplate:res_1,minimal-bw']);
  });

  it('打开着的那份被删了 → 自动退回列表（不停在一个不存在的简历上）', async () => {
    const { api } = fakeApi({ list: [resume('res_1', 'A')], openedId: 'res_gone' });
    await render(api);
    expect(container.querySelector('.resume-home')).not.toBeNull();
    expect(container.querySelector('.resume-editor')).toBeNull();
  });

  it('编辑态可以退回列表', async () => {
    const { api, calls } = fakeApi({ list: [resume('res_1', 'A')], openedId: 'res_1' });
    await render(api);
    await act(async () => button('← 全部简历')!.click());
    expect(calls).toEqual(['close']);
  });

  it('列表行上的「主版本」色带由 api 的主版本归属决定', async () => {
    const versions: ResumeVersion[] = [
      {
        id: 'ver_1',
        resumeId: 'res_1',
        label: 'v1',
        templateId: 'tech-single',
        content: { sections: [] },
        createdAt: '2026-03-01T00:00:00.000Z',
        deletedAt: null,
      },
    ];
    const { api } = fakeApi({ list: [resume('res_1', 'A')], versions });
    (api.resume as { primaryVersionId: string | null }).primaryVersionId = 'ver_1';
    await render(api);

    expect(container.querySelector('.resume-row--primary')).not.toBeNull();
    expect(container.querySelector('.resume-row__meta')?.textContent).toContain('1 个版本');
  });
});
