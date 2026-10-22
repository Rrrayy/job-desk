// @vitest-environment jsdom
/**
 * BindVersionSelect（投递侧绑定选择器）—— T06 的 UI 侧回归。
 *
 * 这一组守的是「诚实」而不是「能选」：
 * - 候选里只有冻结版本（草稿不是版本，结构性进不来；已删的也不进）；
 * - 绑的版本被删后，下拉里保留一个 disabled 选项把「v1（已删除）」亮出来，
 *   偷偷跳到「未绑定」会让用户以为投递记录丢了；
 * - 改绑留痕就摆在字段旁边（≤3 条 + 总次数）；
 * - 解绑要真的把 null 传给 api（不能只改 UI）。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppApi } from '../lib/api';
import type { Application, DB, ResumeVersion } from '../types';
import { emptyDB } from '../lib/defaults';
import { BindVersionSelect } from './BindVersionSelect';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AT = '2026-03-01T10:00:00.000Z';

function version(id: string, label: string, resumeId: string, deletedAt: string | null = null): ResumeVersion {
  return { id, resumeId, label, templateId: 'tech-single', content: { sections: [] }, createdAt: AT, deletedAt };
}

function app(overrides: Partial<Application> = {}): Application {
  return {
    id: 'app-1',
    companyId: 'c-1',
    jobTitle: '前端实习',
    status: 'applied',
    statusChangedAt: '2026-02-20T01:00:00.000Z',
    lastActivityAt: '2026-02-20T01:00:00.000Z',
    createdAt: '2026-02-20T01:00:00.000Z',
    updatedAt: '2026-02-20T01:00:00.000Z',
    ...overrides,
  };
}

interface FakeOptions {
  db: DB;
  calls: string[];
}

function fakeApi(options: FakeOptions): AppApi {
  return {
    db: options.db,
    bindResumeVersion: (appId: string, versionId: string | null) => {
      options.calls.push(`bind:${appId},${versionId ?? 'null'}`);
      return true;
    },
  } as unknown as AppApi;
}

function makeDB(versions: ResumeVersion[], applications: Application[]): DB {
  const db = emptyDB();
  db.resumes = [
    { id: 'res-1', name: '前端 - 主投', templateId: 'tech-single', content: { sections: [] }, createdAt: AT, updatedAt: AT, deletedAt: null },
  ];
  db.resumeVersions = versions;
  db.applications = applications;
  return db;
}

describe('BindVersionSelect（jsdom）', () => {
  let host: HTMLDivElement;
  let root: Root | null = null;
  const calls: string[] = [];

  const render = (api: AppApi, current: Application): void => {
    act(() => {
      root?.render(<BindVersionSelect api={api} app={current} />);
    });
  };

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    calls.length = 0;
  });

  afterEach(() => {
    act(() => root?.unmount());
    host.remove();
    root = null;
  });

  const select = (): HTMLSelectElement => host.querySelector('select[aria-label="绑定的简历版本"]')!;

  const choose = (value: string): void => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(select(), value);
      select().dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  it('正常绑定：显示当前版本，候选带简历名前缀（同名 v1 靠它分辨）', () => {
    const current = app({ resumeVersionId: 'ver-1', resumeVersion: 'v1' });
    const api = fakeApi({
      db: makeDB([version('ver-1', 'v1', 'res-1'), version('ver-2', 'v1', 'res-1')], [current]),
      calls,
    });
    render(api, current);

    expect(select().value).toBe('ver-1');
    const labels = [...select().querySelectorAll('option')].map((option) => option.textContent);
    expect(labels).toContain('前端 - 主投 · v1');
    expect(labels).toContain('前端 - 主投 · v1'); // 两个同名版本都是合法候选
    expect(labels.filter((label) => label === '前端 - 主投 · v1')).toHaveLength(2);
  });

  it('★ 绑的版本被删：disabled 选项保留「v1（已删除）」，不偷偷跳成未绑定', () => {
    const current = app({ resumeVersionId: 'ver-1', resumeVersion: 'v1' });
    const api = fakeApi({
      db: makeDB([version('ver-1', 'v1', 'res-1', AT)], [current]),
      calls,
    });
    render(api, current);

    const dangling = [...select().querySelectorAll('option')].find((option) => option.disabled)!;
    expect(dangling.textContent).toContain('v1（已删除）');
    expect(select().className).toContain('bind__select--dangling');
    expect(host.textContent).toContain('版本已删除，投递记录保留');
  });

  it('旧文本数据：hint 说明会归入旧数据桶，选中值是「未绑定」而不是悬空', () => {
    const current = app({ resumeVersion: 'v3-前端-项目版' });
    const api = fakeApi({ db: makeDB([], [current]), calls });
    render(api, current);

    expect(select().value).toBe('none');
    expect(host.textContent).toContain('旧数据的文本快照');
  });

  it('★ 改绑：change 事件把新版本 id 原样传给 api（不传快照名、不传对象）', () => {
    const current = app({ resumeVersionId: 'ver-1', resumeVersion: 'v1' });
    const api = fakeApi({
      db: makeDB([version('ver-1', 'v1', 'res-1'), version('ver-2', 'v2', 'res-1')], [current]),
      calls,
    });
    render(api, current);

    choose('ver-2');
    expect(calls).toEqual(['bind:app-1,ver-2']);
  });

  it('★ 解绑：选「未绑定」必须把 null 传给 api', () => {
    const current = app({ resumeVersionId: 'ver-1', resumeVersion: 'v1' });
    const api = fakeApi({
      db: makeDB([version('ver-1', 'v1', 'res-1')], [current]),
      calls,
    });
    render(api, current);

    choose('none');
    expect(calls).toEqual(['bind:app-1,null']);
  });

  it('改绑留痕：总数在 summary 上，展开后最新在前、最多 3 条', () => {
    const current = app({
      resumeVersionId: 'ver-2',
      resumeVersion: 'v2',
      resumeBindLog: [
        { versionId: 'ver-1', label: 'v1', at: '2026-03-01T10:00:00.000Z' },
        { versionId: 'ver-2', label: 'v2', at: '2026-03-05T10:00:00.000Z' },
        { versionId: 'ver-3', label: 'v3', at: '2026-03-06T10:00:00.000Z' },
        { versionId: 'ver-4', label: 'v4', at: '2026-03-07T10:00:00.000Z' },
      ],
    });
    const api = fakeApi({ db: makeDB([version('ver-2', 'v2', 'res-1')], [current]), calls });
    render(api, current);

    const summary = host.querySelector('summary')!;
    expect(summary.textContent).toContain('改绑记录（4）');
    act(() => summary.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const items = [...host.querySelectorAll('.bind__log li')].map((item) => item.textContent);
    expect(items).toEqual(['3/7 18:00 · v4', '3/6 18:00 · v3', '3/5 18:00 · v2']);
  });

  it('从没改绑过：不渲染留痕区（一个空的「改绑记录（0）」是噪音）', () => {
    const current = app({ resumeVersionId: 'ver-1', resumeVersion: 'v1' });
    const api = fakeApi({ db: makeDB([version('ver-1', 'v1', 'res-1')], [current]), calls });
    render(api, current);

    expect(host.querySelector('.bind__log')).toBeNull();
  });

  it('★ 候选里没有已删版本、也没有「草稿」这一项 —— 禁绑不是靠 disabled 拦的，是靠不出', () => {
    const current = app();
    const api = fakeApi({
      db: makeDB([version('ver-1', 'v1', 'res-1'), version('ver-dead', 'v0', 'res-1', AT)], [current]),
      calls,
    });
    render(api, current);

    const values = [...select().querySelectorAll('option')].map((option) => option.value);
    expect(values).toEqual(['none', 'ver-1']);
    expect(values).not.toContain('draft');
    expect(values).not.toContain('ver-dead');
  });
});
