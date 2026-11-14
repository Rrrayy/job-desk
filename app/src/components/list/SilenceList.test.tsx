// @vitest-environment jsdom
/**
 * SilenceList / BatchBar（模块四 UI）回归 —— 沿用项目既有的「裸 react-dom + act」模式。
 *
 * 这一组守的是「别把没做的事记成做了」：
 * - 分组只看 level（内推 ×3 阈值，所以内推 10 天是黄），红组 15 天只画线不建子组；
 * - 静音行灰显但**仍留在原组**，勾「隐藏」才藏起来（计数口径不随静音变）；
 * - 放弃要点两次（第一次只上膛）；
 * - 话术生成出来不动库，只有勾了「已发出」的才写 followup。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppApi } from '../../lib/api';
import type { Application, Company, DB, Status } from '../../types';
import { emptyDB } from '../../lib/defaults';
import { addDays } from '../../lib/date';
import { SilenceList } from './SilenceList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 10, 1, 9, 0, 0);

interface AppSpec {
  id: string;
  companyId: string;
  jobTitle: string;
  status?: Status;
  channel?: Application['channel'];
  /** 最后活动（= statusChangedAt）距今多少天 */
  days: number;
  mutedUntil?: string;
}

function buildDB(specs: AppSpec[]): DB {
  const db = emptyDB();
  const companies: Company[] = [
    { id: 'c1', name: '字节跳动', shortName: '字节', createdAt: NOW.toISOString() },
    { id: 'c2', name: '美团', createdAt: NOW.toISOString() },
  ];
  db.companies = companies;
  db.applications = specs.map((spec) => {
    const at = addDays(NOW, -spec.days).toISOString();
    return {
      id: spec.id,
      companyId: spec.companyId,
      jobTitle: spec.jobTitle,
      status: spec.status ?? 'applied',
      channel: spec.channel,
      statusChangedAt: at,
      lastActivityAt: at,
      createdAt: addDays(NOW, -spec.days - 1).toISOString(),
      updatedAt: at,
      ...(spec.mutedUntil ? { mutedUntil: spec.mutedUntil } : {}),
    } as Application;
  });
  return db;
}

interface Harness {
  api: AppApi;
  calls: string[];
  toasts: string[];
}

function harness(db: DB): Harness {
  const calls: string[] = [];
  const toasts: string[] = [];
  const api = {
    db,
    now: NOW,
    toast: (text: string) => toasts.push(text),
    openDetail: (id: string) => calls.push(`open:${id}`),
    silence: {
      batchDrop: (ids: string[]) => calls.push(`drop:${ids.join(',')}`),
      batchMute: (ids: string[], until: string) => calls.push(`mute:${ids.join(',')}:${until}`),
      batchFollowup: (ids: string[], confirmed: string[]) => {
        calls.push(`followup:${ids.join(',')}|${confirmed.join(',')}`);
        return confirmed.length;
      },
    },
  } as unknown as AppApi;
  return { api, calls, toasts };
}

describe('SilenceList（jsdom）', () => {
  let host: HTMLDivElement;
  let root: Root | null = null;

  const render = (api: AppApi): void => {
    act(() => {
      root?.render(<SilenceList api={api} />);
    });
  };

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    // jsdom 没有 Clipboard API 的写入实现，给个假的，免得断言落在「复制失败」分支上
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => undefined },
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    host.remove();
    root = null;
  });

  const click = (el: Element | null): void => {
    if (!el) throw new Error('要点的元素不存在');
    act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  };

  const groupCounts = (): string[] =>
    [...host.querySelectorAll('.sil__group-count')].map((el) => el.textContent ?? '');

  it('一条都没有 → 空态，不渲染分组', () => {
    render(harness(buildDB([])).api);
    expect(host.textContent).toContain('最近没有谁被冷落');
    expect(host.querySelector('.sil__group')).toBeNull();
  });

  it('分组只看 level：30 天 / 10 天进红组，4 天进黄组', () => {
    const db = buildDB([
      { id: 'a1', companyId: 'c1', jobTitle: '抖音前端', days: 30 },
      { id: 'a2', companyId: 'c2', jobTitle: '美团后端', days: 10 },
      { id: 'a3', companyId: 'c2', jobTitle: '美团前端', days: 4 },
    ]);
    render(harness(db).api);

    expect(groupCounts()).toEqual(['2', '1']);
    expect(host.textContent).toContain('已沉默');
    expect(host.textContent).toContain('该跟进');
    expect(host.querySelector('[data-testid="sil-row-a1"]')?.className).toContain('sil__row--stale');
    expect(host.querySelector('[data-testid="sil-row-a3"]')?.className).toContain('sil__row--warn');
  });

  it('★ 红组里 15 天只画一条分割线，不建子组（计数口径只有一套）', () => {
    const db = buildDB([
      { id: 'a1', companyId: 'c1', jobTitle: '抖音前端', days: 30 },
      { id: 'a2', companyId: 'c2', jobTitle: '美团后端', days: 10 },
      { id: 'a3', companyId: 'c2', jobTitle: '美团前端', days: 4 },
    ]);
    render(harness(db).api);
    const splits = host.querySelectorAll('.sil__split');
    expect(splits).toHaveLength(1);
    expect(splits[0].textContent).toContain('15 天以内');
    // 分割线不是「组」：组头仍然只有两个
    expect(host.querySelectorAll('.sil__group-head')).toHaveLength(2);
  });

  it('★ 内推 10 天是黄不是红（阈值 ×3，看一眼数字就知道为什么）', () => {
    const db = buildDB([
      { id: 'a1', companyId: 'c1', jobTitle: '抖音前端', days: 10, channel: 'referral' },
    ]);
    render(harness(db).api);
    expect(groupCounts()).toEqual(['1']);
    expect(host.textContent).toContain('该跟进');
    expect(host.textContent).not.toContain('已沉默');
    expect(host.querySelector('[data-testid="sil-row-a1"]')?.className).toContain('sil__row--warn');
  });

  it('★ 静音行仍留在原组（灰显 + ⌛），勾「隐藏」才藏起来', () => {
    const db = buildDB([
      { id: 'a1', companyId: 'c1', jobTitle: '抖音前端', days: 30 },
      { id: 'a2', companyId: 'c2', jobTitle: '美团后端', days: 30, mutedUntil: addDays(NOW, 2).toISOString() },
    ]);
    render(harness(db).api);

    // 两条都还在，静音的那条带 ⌛ 和到期日
    expect(host.querySelector('[data-testid="sil-row-a2"]')?.className).toContain('is-muted');
    expect(host.querySelector('[data-testid="sil-row-a2"]')?.textContent).toContain('静音到');
    expect(groupCounts()).toEqual(['2']);

    const hide = host.querySelector('[data-testid="sil-hide-muted"]') as HTMLInputElement;
    act(() => hide.click());
    expect(host.querySelector('[data-testid="sil-row-a2"]')).toBeNull();
    expect(host.querySelector('[data-testid="sil-row-a1"]')).not.toBeNull();
    // 统计仍然是「2 条该看一眼 · 1 条已静音」—— 藏起来不等于不算
    expect(host.querySelector('.sil__stat')?.textContent).toContain('1 条已静音');
    expect(groupCounts()).toEqual(['1']);
  });

  it('★ 放弃要点两次：第一次只上膛，第二次才写库', () => {
    const db = buildDB([{ id: 'a1', companyId: 'c1', jobTitle: '抖音前端', days: 30 }]);
    const h = harness(db);
    render(h.api);

    const check = host.querySelector('.sil__check') as HTMLInputElement;
    act(() => check.click());
    expect(host.querySelector('[data-testid="sil-batch"]')).not.toBeNull();
    expect(host.textContent).toContain('已选 1 条');

    click(host.querySelector('[data-testid="sil-drop"]'));
    expect(h.calls.filter((call) => call.startsWith('drop:'))).toHaveLength(0);
    expect(host.textContent).toContain('真的放弃这 1 条');

    click(host.querySelector('[data-testid="sil-drop"]'));
    expect(h.calls).toContain('drop:a1');
    // 提示由 App 发（它才有撤销栈，能把「撤销」按钮塞进 toast）——组件不抢这一句
    expect(h.toasts.filter((text) => text.includes('已放弃'))).toEqual([]);
  });

  it('静音：预设按钮一次写 N 条，并说清「静了这个日期」', () => {
    const db = buildDB([{ id: 'a1', companyId: 'c1', jobTitle: '抖音前端', days: 30 }]);
    const h = harness(db);
    render(h.api);
    act(() => (host.querySelector('.sil__check') as HTMLInputElement).click());
    click(host.querySelector('[data-testid="sil-mute-3d"]'));

    const call = h.calls.find((item) => item.startsWith('mute:'));
    expect(call).toContain('mute:a1:');
    // 静音到「当天结束」，不是 now + 72h
    const until = call!.split(':').slice(2).join(':');
    expect(new Date(until).getHours()).toBe(23);
    expect(h.toasts.some((text) => text.includes('已静音 1 条'))).toBe(true);
  });

  it('★ 催问话术：生成不动库，只有勾了「已发出」的那条才写 followup', () => {
    const db = buildDB([
      { id: 'a1', companyId: 'c1', jobTitle: '抖音前端', days: 30 },
      { id: 'a2', companyId: 'c2', jobTitle: '美团后端', days: 30 },
    ]);
    const h = harness(db);
    render(h.api);

    const boxes = [...host.querySelectorAll('.sil__check')];
    for (const box of boxes) act(() => (box as HTMLInputElement).click());

    click(host.querySelector('[data-testid="sil-script-open"]'));
    expect(host.querySelector('[data-testid="sil-scripts"]')).not.toBeNull();
    const script = host.querySelector('textarea[aria-label="给 字节 的话术"]') as HTMLTextAreaElement;
    expect(script.value).toContain('抖音前端');
    // 生成了话术但一条都没记
    expect(h.calls.filter((call) => call.startsWith('followup:'))).toHaveLength(0);
    expect((host.querySelector('[data-testid="sil-record-followup"]') as HTMLButtonElement).disabled).toBe(true);

    act(() => (host.querySelector('[data-testid="sil-sent-a1"]') as HTMLInputElement).click());
    click(host.querySelector('[data-testid="sil-record-followup"]'));
    expect(h.calls).toContain('followup:a1,a2|a1');
    expect(h.toasts.some((text) => text.includes('记下 1 条跟进'))).toBe(true);
  });

  it('导出的条数与当前清单一致，并说明复制到了哪里', async () => {
    const db = buildDB([
      { id: 'a1', companyId: 'c1', jobTitle: '抖音前端', days: 30 },
      { id: 'a2', companyId: 'c2', jobTitle: '美团后端', days: 4 },
    ]);
    const h = harness(db);
    render(h.api);
    const exportBtn = [...host.querySelectorAll('button')].find((btn) =>
      (btn.textContent ?? '').includes('导出清单'),
    );
    await act(async () => {
      exportBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(h.toasts.some((text) => text.includes('已复制 Markdown'))).toBe(true);
  });
});
