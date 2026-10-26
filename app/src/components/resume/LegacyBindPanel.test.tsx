// @vitest-environment jsdom
/**
 * 旧数据归类面板（v0.9.1 / R-RES-9 的 UI 侧）。
 *
 * 这一组守的是「归类这个动作的四个出口都不静默」：
 * - 选了版本 → 真的调了 `bindResumeVersion`（且只有这一条通道）；
 * - 跳过 / 不属于任何版本 → **零写入**（用户没表态就不能替他表态）；
 * - 关闭 → 零写入，已经处理过的不会再出现（队列在打开时快照）；
 * - 失败（版本刚被删）→ 不假装成功，给出口；
 * - 进度用 `aria-live` 播报，屏幕阅读器能听到「3 / 12」。
 *
 * 另一个重点是**不做批量**：「另有 N 条写的是同一个文本」只是提示，
 * 点一次「归到这一版」只处理当前这一条 —— 这条断言防止将来有人「顺手优化」成批量。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppApi } from '../../lib/api';
import type { Application, DB, Resume, ResumeVersion } from '../../types';
import { emptyDB } from '../../lib/defaults';
import { LegacyBindPanel } from './LegacyBindPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AT = '2026-02-20T01:00:00.000Z';

function makeApp(overrides: Partial<Application> = {}): Application {
  return {
    id: overrides.id ?? 'app-1',
    companyId: overrides.companyId ?? 'c-1',
    jobTitle: overrides.jobTitle ?? '前端实习',
    status: overrides.status ?? 'applied',
    statusChangedAt: AT,
    lastActivityAt: AT,
    createdAt: AT,
    updatedAt: AT,
    appliedAt: '2026-02-18',
    ...overrides,
  };
}

function makeResume(id = 'res-1', name = '前端 - 主投'): Resume {
  return {
    id,
    name,
    templateId: 'tech-single',
    content: { sections: [] } as unknown as Resume['content'],
    createdAt: AT,
    updatedAt: AT,
    deletedAt: null,
  };
}

function makeVersion(id: string, resumeId: string, label: string, overrides: Partial<ResumeVersion> = {}): ResumeVersion {
  return {
    id,
    resumeId,
    label,
    templateId: 'tech-single',
    content: { sections: [] } as unknown as ResumeVersion['content'],
    createdAt: AT,
    deletedAt: null,
    ...overrides,
  };
}

/**
 * 只实现面板真正用到的成员（其余一律不给 —— 用到就会炸，正好当护栏）。
 *
 * ★ v0.9 T06 教训：组件新增数据依赖必须同步测试夹具，否则不是 8 条红，是一整片红。
 * 这个假 api 里 `db.companies` / `db.resumes` / `db.resumeVersions` /
 * `bindResumeVersion` / `toast` 都是面板的直接依赖，缺一不可。
 */
function makeApi(options: {
  apps: Application[];
  versions?: ResumeVersion[];
  resumes?: Resume[];
  bindResult?: boolean;
}): { api: AppApi; bind: ReturnType<typeof vi.fn>; toast: ReturnType<typeof vi.fn> } {
  const db: DB = emptyDB();
  db.applications = options.apps;
  db.companies = [
    { id: 'c-1', name: '字节跳动', shortName: '字节', createdAt: AT },
    { id: 'c-2', name: '腾讯科技', createdAt: AT },
  ];
  db.resumes = options.resumes ?? [makeResume()];
  db.resumeVersions = options.versions ?? [makeVersion('ver-1', 'res-1', 'v1'), makeVersion('ver-2', 'res-1', 'v2')];

  const bind = vi.fn(() => options.bindResult ?? true);
  const toast = vi.fn();
  const api = { db, bindResumeVersion: bind, toast, now: new Date(AT) } as unknown as AppApi;
  return { api, bind, toast };
}

describe('LegacyBindPanel（jsdom）', () => {
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

  async function render(api: AppApi, onClose = vi.fn()): Promise<{ onClose: ReturnType<typeof vi.fn> }> {
    root = createRoot(container);
    await act(async () => {
      root.render(<LegacyBindPanel api={api} onClose={onClose} />);
    });
    return { onClose };
  }

  const select = (): HTMLSelectElement =>
    container.querySelector<HTMLSelectElement>('select[aria-label="选择这一条投递对应的简历版本"]')!;
  const button = (text: string): HTMLButtonElement => {
    const found = Array.from(container.querySelectorAll('button')).find((item) =>
      item.textContent?.includes(text),
    );
    if (!found) throw new Error(`找不到按钮：${text}`);
    return found;
  };
  const setSelect = (value: string): void => {
    const element = select();
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };

  it('★ 一条一条走：显示公司 / 岗位 / 手输文本，进度用 aria-live 播报', async () => {
    const { api } = makeApi({ apps: [makeApp({ resumeVersion: 'v3-前端-项目版' }), makeApp({ id: 'app-2', resumeVersion: 'v3' })] });
    await render(api);

    expect(container.textContent).toContain('字节 · 前端实习');
    expect(container.textContent).toContain('v3-前端-项目版');
    const progress = container.querySelector('[aria-live="polite"]');
    expect(progress?.textContent).toBe('1 / 2');
  });

  it('★ 选了版本 → 调 bindResumeVersion（唯一写库通道），并前进到下一条', async () => {
    const { api, bind } = makeApi({
      apps: [makeApp({ id: 'app-1', resumeVersion: 'v1' }), makeApp({ id: 'app-2', resumeVersion: 'v2' })],
    });
    await render(api);

    await act(async () => setSelect('ver-2'));
    await act(async () => button('归到这一版').click());

    expect(bind).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledWith('app-1', 'ver-2');
    expect(container.textContent).toContain('2 / 2');
  });

  it('★ 未选版本前「归到这一版」不可点（不替用户猜）', async () => {
    const { api, bind } = makeApi({ apps: [makeApp({ resumeVersion: 'v1' })] });
    await render(api);

    expect(button('归到这一版').disabled).toBe(true);
    await act(async () => button('归到这一版').click());
    expect(bind).not.toHaveBeenCalled();
  });

  it('★ 跳过 = 零写入，且会前进（不替用户表态）', async () => {
    const { api, bind } = makeApi({
      apps: [makeApp({ id: 'app-1', resumeVersion: 'v1' }), makeApp({ id: 'app-2', resumeVersion: 'v2' })],
    });
    await render(api);

    await act(async () => button('跳过').click());
    expect(bind).not.toHaveBeenCalled();
    expect(container.textContent).toContain('2 / 2');
  });

  it('★「不属于任何版本」同样零写入（文案说清了，但行为等同跳过 —— 零 schema）', async () => {
    const { api, bind } = makeApi({
      apps: [makeApp({ id: 'app-1', resumeVersion: 'v1' }), makeApp({ id: 'app-2', resumeVersion: 'v2' })],
    });
    await render(api);

    await act(async () => button('不属于任何版本').click());
    expect(bind).not.toHaveBeenCalled();
    expect(container.textContent).toContain('2 / 2');
  });

  it('★ 同文本的条数只作提示，点一次只处理当前一条（不做批量）', async () => {
    const { api, bind } = makeApi({
      apps: [
        makeApp({ id: 'app-1', resumeVersion: 'v3' }),
        makeApp({ id: 'app-2', resumeVersion: 'v3' }),
        makeApp({ id: 'app-3', resumeVersion: 'v3' }),
      ],
    });
    await render(api);

    expect(container.textContent).toContain('另有 2 条写的是同一个文本');

    await act(async () => setSelect('ver-1'));
    await act(async () => button('归到这一版').click());

    // 只有一条被写，剩下两条还在队列里等着各自确认
    expect(bind).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledWith('app-1', 'ver-1');
    expect(container.textContent).toContain('2 / 3');
  });

  it('★ 写库失败（版本刚被删）→ 不假装成功、不前进，给出提示', async () => {
    const { api, toast } = makeApi({ apps: [makeApp({ resumeVersion: 'v1' })], bindResult: false });
    await render(api);

    await act(async () => setSelect('ver-1'));
    await act(async () => button('归到这一版').click());

    expect(toast).toHaveBeenCalledWith(expect.stringContaining('已经绑不上了'));
    expect(container.textContent).toContain('1 / 1');
  });

  it('★ 走完最后一条 → 关闭面板并报「这次归了几条」', async () => {
    const { api, toast } = makeApi({ apps: [makeApp({ resumeVersion: 'v1' })] });
    const { onClose } = await render(api);

    await act(async () => setSelect('ver-1'));
    await act(async () => button('归到这一版').click());

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('这次归了 1 条'));
  });

  it('★ 关闭（× / Esc）零写入', async () => {
    const { api, bind } = makeApi({ apps: [makeApp({ resumeVersion: 'v1' })] });
    const { onClose } = await render(api);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click();
    });
    expect(bind).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('归类前告知「显示会变成什么」：选中后写出目标版本名与原文本（F9 后的告知，不是静默覆盖）', async () => {
    const { api } = makeApi({ apps: [makeApp({ resumeVersion: 'v3-前端-项目版' })] });
    await render(api);
    expect(container.textContent).not.toContain('不再显示');

    await act(async () => setSelect('ver-2'));
    expect(container.textContent).toContain('归类后简历列显示为「v2」');
    expect(container.textContent).toContain('原文本「v3-前端-项目版」不再显示');
    // ★ F9 的用户侧承诺也要写在面板上
    expect(container.textContent).toContain('沉默天数也不会被重置');
  });

  it('库里一个版本都没有 → 说清楚先去存版本，而不是给一个空下拉', async () => {
    const { api } = makeApi({ apps: [makeApp({ resumeVersion: 'v1' })], versions: [] });
    await render(api);

    expect(container.textContent).toContain('库里还没有任何版本可以绑');
    expect(button('归到这一版').disabled).toBe(true);
  });

  it('多份简历时下拉里带简历名（否则两个都叫 v1 分不清）', async () => {
    const { api } = makeApi({
      apps: [makeApp({ resumeVersion: 'v1' })],
      resumes: [makeResume('res-1', '前端'), makeResume('res-2', '后端')],
      versions: [makeVersion('ver-1', 'res-1', 'v1'), makeVersion('ver-2', 'res-2', 'v1')],
    });
    await render(api);

    const options = Array.from(select().options).map((option) => option.textContent);
    expect(options).toHaveLength(3);
    // 顺序按简历名拼音（后端 hòu < 前端 qián），所以只断言「都带了简历名」
    expect(options).toContain('前端 · v1');
    expect(options).toContain('后端 · v1');
  });

  it('待归类为空 → 空态 + 只有「知道了」，不渲染四个出口', async () => {
    const { api } = makeApi({ apps: [makeApp({ resumeVersionId: 'ver-1', resumeVersion: 'v1' })] });
    await render(api);

    expect(container.textContent).toContain('没有待归类的旧数据了');
    expect(button('知道了')).toBeTruthy();
    expect(container.textContent).not.toContain('跳出');
    expect(container.textContent).not.toContain('不属于任何版本');
  });
});
