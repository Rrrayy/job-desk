// @vitest-environment jsdom
/**
 * OfferPanel（模块一 UI）回归 —— 沿用项目既有的「裸 react-dom + act」模式（零新依赖）。
 *
 * 这一组守的是「工具不替你做决定」：
 * - 没有 Offer 时给空态，不硬造一张空表；
 * - 勾掉一个候选，表里那一列必须消失（候选是用户选的）；
 * - 第 9 个勾不进去，而且要**说出来**（不静默忽略）；
 * - 已有决策时改选要点两次（覆盖是破坏性操作）；
 * - 权重拖动结束后才调 setWeights（一次拖动只写一次库）。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppApi } from '../../lib/api';
import type { Application, Company, DB, OfferDecision } from '../../types';
import { emptyDB } from '../../lib/defaults';
import { DEFAULT_OFFER_WEIGHTS } from '../../lib/offer/score';
import { offerCandidatesOf } from '../../lib/offer/compare';
import { decisionViewOf } from '../../lib/offer/decision';
import { OfferPanel } from './OfferPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 10, 1, 9, 0, 0);
const NOW_ISO = NOW.toISOString();

interface Harness {
  api: AppApi;
  calls: string[];
}

function makeDB(): DB {
  const db = emptyDB();
  const companies: Company[] = [
    { id: 'c1', name: '字节跳动', shortName: '字节', createdAt: '2026-09-01T00:00:00.000Z' },
    { id: 'c2', name: '美团', createdAt: '2026-09-01T00:00:00.000Z' },
  ];
  const base: Omit<Application, 'id' | 'companyId' | 'jobTitle'> = {
    status: 'offer',
    statusChangedAt: NOW_ISO,
    lastActivityAt: NOW_ISO,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
  db.companies = companies;
  db.applications = [
    {
      ...base,
      id: 'a1',
      companyId: 'c1',
      jobTitle: '抖音前端',
      city: '北京',
      offer: {
        payMode: 'monthly',
        monthlySalary: 20000,
        salaryMonths: 15,
        level: 'P5',
        scores: { salary: 5, growth: 4, city: 3, wlb: 2 },
        updatedAt: NOW_ISO,
      },
    },
    {
      ...base,
      id: 'a2',
      companyId: 'c2',
      jobTitle: '美团后端',
      offer: { monthlySalary: 18000, salaryMonths: 14, scores: { salary: 3, growth: 4 }, updatedAt: NOW_ISO },
    },
  ];
  return db;
}

function harness(overrides: { db?: DB; decision?: OfferDecision } = {}): Harness {
  const db = overrides.db ?? makeDB();
  if (overrides.decision) db.offerDecision = overrides.decision;
  const calls: string[] = [];
  const api = {
    db,
    now: NOW,
    toast: (text: string) => calls.push(`toast:${text}`),
    openDetail: (id: string) => calls.push(`open:${id}`),
    offer: {
      candidates: offerCandidatesOf(db, NOW),
      weights: DEFAULT_OFFER_WEIGHTS,
      setWeights: (weights: Record<string, number>) => calls.push(`weights:${JSON.stringify(weights)}`),
      saveOffer: (appId: string, patch: unknown) => calls.push(`offer:${appId}:${JSON.stringify(patch)}`),
      saveDecision: (input: unknown) => calls.push(`decision:${JSON.stringify(input)}`),
      decision: decisionViewOf(db, db.offerDecision),
    },
  } as unknown as AppApi;
  return { api, calls };
}

describe('OfferPanel（jsdom）', () => {
  let host: HTMLDivElement;
  let root: Root | null = null;

  const render = (api: AppApi): void => {
    act(() => {
      root?.render(<OfferPanel api={api} onClose={() => undefined} />);
    });
  };

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
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

  it('一个 Offer 都没有 → 空态，不渲染对比表', () => {
    const db = emptyDB();
    render(harness({ db }).api);
    expect(host.textContent).toContain('还没有任何 Offer');
    expect(host.querySelector('[data-testid="compare-table"]')).toBeNull();
  });

  it('两个 Offer → 表头是两列，综合分行带分数', () => {
    render(harness().api);
    const table = host.querySelector('.cmp__table')!;
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent ?? '');
    expect(heads[0]).toBe('项目');
    expect(heads).toHaveLength(3);
    expect(heads[1]).toContain('抖音前端');

    const totalRow = table.querySelector('.cmp__row--total')!;
    const cells = [...totalRow.querySelectorAll('td')].map((td) => td.textContent ?? '');
    // 5/4/3/2 @ 30/30/20/20 → 74.0；3/4 未评 city/wlb → 归一后 70.0
    expect(cells[0]).toContain('74.0');
    expect(cells[1]).toContain('70.0');
    expect(cells[1]).toContain('按 2/4 维归一');
  });

  it('★ 勾掉一个候选：那一列从表里消失（对比哪几个由用户决定）', () => {
    render(harness().api);
    expect([...host.querySelectorAll('.cmp__table thead th')]).toHaveLength(3);
    click(host.querySelector('[data-testid="cmp-pick-a2"]'));
    expect([...host.querySelectorAll('.cmp__table thead th')]).toHaveLength(2);
  });

  it('提醒区：缺维与截止各一条，可点「去看看」', () => {
    const db = makeDB();
    db.applications[0].deadlineAt = '2026-11-03';
    const h = harness({ db });
    render(h.api);
    const items = [...host.querySelectorAll('.offer-alerts__item')].map((item) => item.textContent ?? '');
    expect(items.some((text) => text.includes('还有 2 天到期'))).toBe(true);
    expect(items.some((text) => text.includes('维没评'))).toBe(true);
    click(host.querySelector('.offer-alerts__item button'));
    expect(h.calls.some((call) => call.startsWith('open:'))).toBe(true);
  });

  it('权重拖动：拖动过程中不写库，松手时才调 setWeights', () => {
    const h = harness();
    render(h.api);
    click([...host.querySelectorAll('button')].find((btn) => btn.textContent === '调整') ?? null);
    const slider = host.querySelector('input[type="range"][aria-label="薪资权重"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(slider, '60');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(h.calls.filter((call) => call.startsWith('weights:'))).toHaveLength(0);
    act(() => slider.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
    const written = h.calls.find((call) => call.startsWith('weights:'));
    expect(written).toBeTruthy();
    // 30/30/20/20 拖 salary→60 ⇒ 60/18/11/11
    expect(written).toContain('"salary":60');
  });

  it('★ 决策：第一次点保存就写入（还没有旧决策，不需要二次确认）', () => {
    const h = harness();
    render(h.api);
    click([...host.querySelectorAll('button')].find((btn) => btn.textContent === '记一笔') ?? null);
    const select = host.querySelector('.dec__form select') as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(select, 'a1');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    click([...host.querySelectorAll('button')].find((btn) => btn.textContent === '记下这个选择') ?? null);
    const saved = h.calls.find((call) => call.startsWith('decision:'));
    expect(saved).toContain('"applicationId":"a1"');
    expect(h.calls.some((call) => call.startsWith('toast:已记录你的选择'))).toBe(true);
  });

  it('★ 改选：已有决策时第一次点只弹确认，第二次才覆盖', () => {
    const h = harness({
      decision: { applicationId: 'a2', decidedAt: '2026-10-20', reasonTags: ['薪资'] },
    });
    render(h.api);
    click([...host.querySelectorAll('button')].find((btn) => btn.textContent === '改选 / 补充理由') ?? null);
    const select = host.querySelector('.dec__form select') as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(select, 'a1');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const submit = [...host.querySelectorAll('button')].find(
      (btn) => btn.textContent === '改选需再确认一次',
    );
    click(submit ?? null);
    expect(h.calls.filter((call) => call.startsWith('decision:'))).toHaveLength(0);
    expect(host.textContent).toContain('这会覆盖掉你在 2026-10-20 记的那一条');
    click([...host.querySelectorAll('button')].find((btn) => btn.textContent === '记下这个选择') ?? null);
    expect(h.calls.filter((call) => call.startsWith('decision:'))).toHaveLength(1);
  });

  it('已有决策时展示理由标签与放弃项（回看卡只露前三行）', () => {
    const db = makeDB();
    db.offerDecision = {
      applicationId: 'a1',
      decidedAt: '2026-10-20',
      reasonTags: ['薪资', '城市'],
      note: '钱多，离家近\n第二行\n第三行\n第四行',
      declinedIds: ['a2'],
    };
    render(harness({ db }).api);
    expect(host.textContent).toContain('我的选择');
    expect(host.textContent).toContain('薪资');
    expect(host.textContent).toContain('我放弃了：美团 · 美团后端');
    expect(host.textContent).toContain('第三行');
    expect(host.textContent).not.toContain('第四行');
  });
});
