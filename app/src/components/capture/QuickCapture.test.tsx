// @vitest-environment jsdom
/**
 * QuickCapture（模块三 UI）回归 —— 沿用项目既有的「裸 react-dom + act」模式（零新依赖）。
 *
 * 这一组守的是三层「不许猜」：
 * - 没听懂 → 说没听懂 + 给「改用手动记录」，**绝不静默丢弃**；
 * - 听懂但形式解析不出 → 保存置灰并就地说明缺什么，**绝不默认 video**；
 * - 听懂了也齐了 → 也只写进「待确认」的确认条，点保存才落库。
 *
 * 还有两条产品决定必须在这里钉住：
 * 1. 撤销粒度是「一次写库一个点」，所以 toast 说的是「已记录 N 项，可逐步撤销」；
 * 2. 公司多候选时**必须点一下**才定 —— 曾经这里点了没反应（CAP-5 的回归点）。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppApi } from '../../lib/api';
import type { ConfirmedCapture } from '../../lib/capture/parse';
import type { Application, Company, DB } from '../../types';
import { emptyDB } from '../../lib/defaults';
import { QuickCapture } from './QuickCapture';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 2026-11-01 是周日；「明天」= 11-02，「下午 3 点」= 15:00 */
const NOW = new Date(2026, 10, 1, 9, 0, 0);
const NOW_ISO = NOW.toISOString();

function makeDB(companies: Company[] = defaultCompanies()): DB {
  const db = emptyDB();
  db.companies = companies;
  db.applications = [
    {
      id: 'a1',
      companyId: 'c1',
      jobTitle: '抖音前端',
      status: 'interviewing',
      statusChangedAt: NOW_ISO,
      lastActivityAt: NOW_ISO,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    } as Application,
  ];
  return db;
}

function defaultCompanies(): Company[] {
  return [
    { id: 'c1', name: '字节跳动', shortName: '字节', createdAt: NOW_ISO },
    { id: 'c2', name: '美团', createdAt: NOW_ISO },
  ];
}

interface Harness {
  api: AppApi;
  commits: ConfirmedCapture[];
  toasts: string[];
}

function harness(db: DB = makeDB()): Harness {
  const commits: ConfirmedCapture[] = [];
  const toasts: string[] = [];
  const api = {
    db,
    now: NOW,
    toast: (text: string) => toasts.push(text),
    capture: {
      commit: (input: ConfirmedCapture) => commits.push(input),
    },
  } as unknown as AppApi;
  return { api, commits, toasts };
}

describe('QuickCapture（jsdom）', () => {
  let host: HTMLDivElement;
  let root: Root | null = null;
  let fallbacks: string[] = [];

  const render = (api: AppApi): void => {
    act(() => {
      root?.render(
        <QuickCapture
          api={api}
          onFallback={(raw) => {
            fallbacks.push(raw);
          }}
        />,
      );
    });
  };

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    fallbacks = [];
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

  const textbox = (): HTMLInputElement => host.querySelector('input[aria-label="一句话快记"]') as HTMLInputElement;

  /** 受控 input 的写入方式：走原型 setter + input 事件（React 才认） */
  const type = (value: string): void => {
    const input = textbox();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  const selectValue = (label: string, value: string): void => {
    const select = host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  /**
   * 等解析防抖落地（组件停手 400 ms 才解析）。
   * 用真实定时器而不是假定时器：这一组测的是「用户打完字看到什么」，
   * 假定时器会把 React 的批处理也一起冻住，反而测不到中间态。
   */
  const settle = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 460));
    });
  };

  const saveBtn = (): HTMLButtonElement | null =>
    host.querySelector('[data-testid="capture-save"]');

  it('空输入 → 只有说明，没有确认条也没有保存按钮', async () => {
    render(harness().api);
    expect(host.textContent).toContain('说一句话就能记成一件事');
    expect(host.querySelector('[data-testid="capture-chips"]')).toBeNull();
    expect(saveBtn()).toBeNull();
  });

  it('★ 听懂但形式解析不出 → 保存置灰，并就地说明缺什么', async () => {
    render(harness().api);
    type('明天下午3点字节二面');
    await settle();

    expect(host.querySelector('[data-testid="capture-chips"]')).not.toBeNull();
    const companyRow = host.querySelectorAll('.cap__row')[1];
    expect(companyRow.textContent).toContain('字节');
    // 时间 chip 回显成本地时刻，不是 UTC
    expect(host.textContent).toContain('2026-11-02 15:00');
    expect((host.querySelector('select[aria-label="第几轮"]') as HTMLSelectElement).value).toBe('2');

    expect(saveBtn()?.disabled).toBe(true);
    expect(host.textContent).toContain('面试形式填了才能保存');
    // 形式没选时不许假装能建面试 —— 计划里退化成一条记录，并且说出来
    expect(host.textContent).toContain('会写入 1 条记录');
    expect(host.querySelector('select[aria-label="面试形式"]')?.getAttribute('value')).toBeNull();
  });

  it('★ 选了形式才能保存；保存一次 = 一个撤销点，toast 说的是「可逐步撤销」', async () => {
    const h = harness();
    render(h.api);
    type('明天下午3点字节二面');
    await settle();
    selectValue('面试形式', 'video');

    expect(saveBtn()?.disabled).toBe(false);
    expect(host.textContent).toContain('会写入 1 场面试');

    click(saveBtn());
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].applicationId).toBe('a1');
    expect(h.commits[0].format).toBe('video');
    expect(h.commits[0].scheduledAt).toBe(new Date(2026, 10, 2, 15, 0, 0).toISOString());
    expect(h.toasts).toEqual(['已记录 1 项，可逐步撤销']);
    // 存完清空输入，回到空态
    expect(textbox().value).toBe('');
    expect(host.querySelector('[data-testid="capture-chips"]')).toBeNull();
  });

  it('★ 一句话里带「视频」也不许直接落库：只是把确认条填好，仍要点保存', async () => {
    const h = harness();
    render(h.api);
    type('明天下午3点字节视频二面');
    await settle();

    expect((host.querySelector('select[aria-label="面试形式"]') as HTMLSelectElement).value).toBe('video');
    expect(saveBtn()?.disabled).toBe(false);
    expect(host.textContent).toContain('会写入 1 场面试');
    expect(h.commits).toHaveLength(0);
  });

  it('没听懂 → 说没听懂 + 「改用手动记录」，原文交回表单', async () => {
    render(harness().api);
    type('随便说点什么');
    await settle();

    expect(host.querySelector('[data-testid="capture-failed"]')).not.toBeNull();
    expect(host.textContent).toContain('没听出来要记什么');
    expect(host.querySelector('[data-testid="capture-chips"]')).toBeNull();

    click([...host.querySelectorAll('button')].find((btn) => btn.textContent === '改用手动记录') ?? null);
    expect(fallbacks).toEqual(['随便说点什么']);
  });

  it('★ 不知道哪家公司 → 问「哪家公司？」+ 新建公司「小鹅」，填完岗位才写得了', async () => {
    const h = harness();
    render(h.api);
    type('明天下午3点小鹅二面');
    await settle();

    expect(host.textContent).toContain('哪家公司？');
    const newCompanyBtn = host.querySelector('[data-testid="cap-new-company"]');
    expect(newCompanyBtn?.textContent).toContain('新建公司「小鹅」');
    expect(saveBtn()?.disabled).toBe(true);
    expect(host.textContent).toContain('先选一个岗位，或者新建一家公司');

    click(newCompanyBtn);
    expect(host.textContent).toContain('新建「小鹅」');
    expect(host.textContent).toContain('会新建「小鹅」这条投递');
    // 新建投递这条路建不出面试，就不该同时出现「形式必填」的红字
    expect(host.textContent).not.toContain('形式是必填项');
    expect(host.textContent).toContain('这次只能先建投递');

    const jobInput = host.querySelector('input[aria-label="新岗位名"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(jobInput, '前端开发实习生');
      jobInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(saveBtn()?.disabled).toBe(false);
    expect(host.textContent).toContain('会新建「小鹅」这条投递');
    click(saveBtn());
    expect(h.commits[0].newCompanyName).toBe('小鹅');
    expect(h.commits[0].newJobTitle).toBe('前端开发实习生');
    expect(h.toasts).toEqual(['已记录 1 项，可逐步撤销']);
  });

  it('★ 公司多候选 → 必须点一下才定（点了要有反应）', async () => {
    const companies: Company[] = [
      { id: 'c1', name: '字节跳动', shortName: '字节', createdAt: NOW_ISO },
      { id: 'c3', name: '字节', createdAt: NOW_ISO },
    ];
    const db = makeDB(companies);
    db.applications = [];
    render(harness(db).api);
    type('明天下午3点字节视频二面');
    await settle();

    expect(host.textContent).toContain('有两家可能，选一个：');
    expect(host.querySelector('[data-testid="cap-company-c1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="cap-company-c3"]')).not.toBeNull();
    // 没定公司就没有岗位候选，也不可能保存
    expect(host.textContent).toContain('先选一个岗位，或者新建一家公司');
    expect(saveBtn()?.disabled).toBe(true);

    click(host.querySelector('[data-testid="cap-company-c1"]'));
    expect(host.querySelector('[data-testid="cap-company-c3"]')).toBeNull();
    expect(host.textContent).toContain('字节');
    expect(host.textContent).toContain('这家还没有投递记录');

    // 「换一家」把选择退回去，候选重新出现
    click(host.querySelector('[data-testid="cap-company-reset"]'));
    expect(host.querySelector('[data-testid="cap-company-c3"]')).not.toBeNull();
  });

  it('★ 状态建议默认不勾；勾了才写，且撤销点数如实变成 2', async () => {
    const h = harness();
    render(h.api);
    type('字节二面挂了');
    await settle();

    const box = host.querySelector('[data-testid="cap-status-confirm"]') as HTMLInputElement;
    expect(box).not.toBeNull();
    expect(box.checked).toBe(false);
    expect(host.textContent).toContain('状态 → 已挂');
    expect(host.textContent).toContain('会写入 1 条记录');
    expect(host.textContent).not.toContain('2 个撤销点');

    act(() => box.click());
    expect(host.textContent).toContain('会写入 1 次状态变更 + 1 条记录');
    expect(host.textContent).toContain('共 2 个撤销点，可逐步撤销');

    click(saveBtn());
    expect(h.commits[0].statusConfirmed).toBe(true);
    expect(h.toasts).toEqual(['已记录 2 项，可逐步撤销']);
  });

  it('一次记一件：逗号后面的内容被挡住，并提示先记前半句', async () => {
    render(harness().api);
    type('明天下午3点字节视频二面，另外记得问薪资');
    await settle();
    const tail = host.querySelector('.cap__tail');
    expect(tail?.textContent).toContain('一次记一件');
    expect(tail?.textContent).toContain('另外记得问薪资');
    expect(tail?.textContent).toContain('明天下午3点字节视频二面');
  });

  it('只有日期没有时刻 → 提示补时刻（CAP-3：不建面试，记成一条记录）', async () => {
    render(harness().api);
    type('明天字节二面');
    await settle();
    expect(host.textContent).toContain('只有日期 —— 补个时刻就能进日历');
    expect(host.textContent).toContain('会写入 1 条记录');
    // 没有准确时刻时形式不是必填（因为压根不建面试）
    expect(host.textContent).not.toContain('面试形式填了才能保存');
  });

  it('词典版本与「不联网」的交代必须在界面上', async () => {
    render(harness().api);
    expect(host.textContent).toContain('词典版本 v1');
    expect(host.textContent).toContain('不联网、不上传');
  });
});

/* ============ v1.0.0 · CAP-1 / CAP-5「确认前绝不写库」的字节级断言 ============ */

describe('QuickCapture · 确认之前一个字节都不写（CAP-1 / CAP-5 / CAP-9）', () => {
  let host: HTMLDivElement;
  let root: Root | null = null;

  /**
   * 把 localStorage 全部键值按「键排序」摊平成一串 —— 这是**全量**比对：
   * 不只比 jobdesk.v1，连将来新增的任何 key（偏好 / 回滚点 / failedAt）都会被抓到。
   */
  const snapshot = (): string => {
    const keys = Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index))
      .filter((key): key is string => key !== null)
      .sort();
    return JSON.stringify(keys.map((key) => [key, window.localStorage.getItem(key)]));
  };

  const type = (value: string): void => {
    const input = host.querySelector('input[aria-label="一句话快记"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  const settle = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 460));
    });
  };

  const saveBtn = (): HTMLButtonElement | null => host.querySelector('[data-testid="capture-save"]');

  const renderWith = (db: DB): void => {
    const api = {
      db,
      now: NOW,
      toast: () => undefined,
      capture: { commit: () => undefined },
    } as unknown as AppApi;
    act(() => {
      root?.render(<QuickCapture api={api} onFallback={() => undefined} />);
    });
  };

  beforeEach(() => {
    window.localStorage.clear();
    // 预置一份「用户已有的库」，任何写入都会改变快照
    window.localStorage.setItem('jobdesk.v1', JSON.stringify({ settings: { schemaVersion: 6 } }));
    window.localStorage.setItem('jobdesk.v1.silencePrefs', '{"hideMuted":true}');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    host.remove();
    root = null;
    window.localStorage.clear();
  });

  it('★ 「明天下午3点字节二面」确认条出现后，localStorage 全量比对逐字节相同', async () => {
    renderWith(makeDB());
    const before = snapshot();

    type('明天下午3点字节二面');
    await settle();

    // 确认条真的出来了（不是「什么都没发生所以当然没写库」）
    expect(host.querySelector('[data-testid="capture-chips"]')).not.toBeNull();
    expect(host.textContent).toContain('字节');
    expect(saveBtn()).not.toBeNull();

    expect(snapshot()).toBe(before);
  });

  it('★ 库内有两条字节投递 → 岗位 chip 为空且保存禁用（不许默认取第一条）', async () => {
    const db = makeDB();
    db.applications.push({
      id: 'a2',
      companyId: 'c1',
      jobTitle: '飞书前端',
      status: 'applied',
      statusChangedAt: NOW_ISO,
      lastActivityAt: NOW_ISO,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    } as Application);
    renderWith(db);
    const before = snapshot();

    type('明天下午3点字节二面');
    await settle();

    expect(saveBtn()).not.toBeNull();
    expect(saveBtn()?.disabled).toBe(true);
    expect(host.textContent).toContain('先选一个岗位');
    expect(snapshot()).toBe(before);
  });

  it('★ 「今天有点累」→ 没听懂、没有保存按钮、localStorage 未变、原文留在输入框', async () => {
    renderWith(makeDB());
    const before = snapshot();

    type('今天有点累');
    await settle();

    expect(host.querySelector('[data-testid="capture-saved"]')).toBeNull();
    expect(saveBtn()).toBeNull();
    expect(host.textContent).toContain('没听出来要记什么');
    const input = host.querySelector('input[aria-label="一句话快记"]') as HTMLInputElement;
    expect(input.value).toBe('今天有点累');
    expect(snapshot()).toBe(before);
  });

  /**
   * CAP-4（P0）：解析出的日期早于今天时，PRD §3.3 与 ARCH §4.1 的时序图都写的是
   * 「弹「这天已经过了，是明年吗？」**二选**；选「否」→ 时间 chip 清空（等待手选）」。
   *
   * 现在的实现只有一句红字提示，没有二选、也没有「选否清空」——
   * 于是用户可以带着一个「今年已经过去的日期」直接保存，把面试记到过去。
   * 这条断言允许任何形式的二选（是/否、明年/手选 …），只要求「能明确表达否，且否 → 时间清空」。
   */
  it('★ 过去日期（CAP-4）：必须能选「否」，且选否后时间 chip 回「未定」', async () => {
    renderWith(makeDB());
    type('1月5日字节一面');
    await settle();

    // 提示在（这一半已经实现）
    expect(host.textContent).toContain('这天已经过了');

    // 二选必须在：任一按钮的文案里含「否」/「不」/「手选」都算
    const negative = Array.from(host.querySelectorAll('button')).find((button) =>
      ['否', '不是', '不', '手选日期'].some((text) => button.textContent?.trim() === text),
    );
    expect(negative).toBeTruthy();

    await act(async () => {
      negative?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // 选「否」之后时间 chip 必须回到「未定」，等用户手选
    expect(host.textContent).toContain('未定');
  });
});
