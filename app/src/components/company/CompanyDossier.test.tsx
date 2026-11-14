// @vitest-environment jsdom
/**
 * CompanyDossier（模块二 UI）回归。
 *
 * 守四件事：
 * - 空字段不产生行（COM-2）：不出现「规模：—」这种占位；
 * - 员工口碑与面试体感是两个标签（合并会让用户以为是一回事）；
 * - 已删除的投递不进档案（删了还看得见是最伤信任的 bug）；
 * - 面经跳题库时把原始 companyName 一起带走（COM-3：两边 N 必须同口径）。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppApi } from '../../lib/api';
import type { Application, Company, DB, Note } from '../../types';
import { emptyDB } from '../../lib/defaults';
import { CompanyDossier } from './CompanyDossier';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 10, 1, 9, 0, 0);
const NOW_ISO = NOW.toISOString();

function app(id: string, overrides: Partial<Application> = {}): Application {
  return {
    id,
    companyId: 'c1',
    jobTitle: `岗位 ${id}`,
    status: 'interviewing',
    statusChangedAt: NOW_ISO,
    lastActivityAt: NOW_ISO,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

function buildDB(company: Company): DB {
  const db = emptyDB();
  db.companies = [company];
  db.applications = [app('a1', { status: 'rejected', jobTitle: '抖音前端' }), app('a2', { jobTitle: '飞书前端' })];
  const note: Note = {
    id: 'n1',
    applicationId: 'a1',
    type: 'chat',
    content: 'HR 说下周给答复',
    touchedAt: '2026-10-05T10:00:00.000Z',
  };
  db.notes = [note];
  db.interviews = [
    {
      id: 'iv1',
      applicationId: 'a1',
      round: 2,
      scheduledAt: '2026-10-03T14:00:00.000Z',
      format: 'video',
      result: 'failed',
    },
  ];
  db.experiences = [
    {
      id: 'e1',
      companyName: '字节跳动',
      interviewDate: '2026-10-03',
      result: 'failed',
      source: 'self',
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
  ];
  db.questions = [
    {
      id: 'q1',
      experienceId: 'e1',
      category: 'algo',
      difficulty: 3,
      text: '手写 LRU',
      mastery: 0,
      tags: [],
      reviewCount: 0,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
  ];
  return db;
}

interface Harness {
  api: AppApi;
  calls: string[];
}

function harness(db: DB, dossierId: string | null = 'c1'): Harness {
  const calls: string[] = [];
  const api = {
    db,
    now: NOW,
    openDetail: (id: string) => calls.push(`open:${id}`),
    company: {
      dossierId,
      closeDossier: () => calls.push('close'),
      saveExtras: (id: string, patch: unknown) => calls.push(`extras:${id}:${JSON.stringify(patch)}`),
      openQuestionBank: (names: string[]) => calls.push(`bank:${names.join('|')}`),
    },
  } as unknown as AppApi;
  return { api, calls };
}

describe('CompanyDossier（jsdom）', () => {
  let host: HTMLDivElement;
  let root: Root | null = null;

  const render = (api: AppApi): void => {
    act(() => {
      root?.render(<CompanyDossier api={api} />);
    });
  };

  const click = (el: Element | null): void => {
    if (!el) throw new Error('要点的元素不存在');
    act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
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

  it('没打开任何档案 → 什么都不渲染', () => {
    render(harness(buildDB({ id: 'c1', name: '字节跳动', createdAt: NOW_ISO }), null).api);
    expect(host.innerHTML).toBe('');
  });

  it('公司不存在 → 不渲染空抽屉', () => {
    render(harness(buildDB({ id: 'c1', name: '字节跳动', createdAt: NOW_ISO }), 'c-missing').api);
    expect(host.innerHTML).toBe('');
  });

  it('★ 空字段不产生行：只有名字的公司不出现「规模」这一行', () => {
    render(harness(buildDB({ id: 'c1', name: '字节跳动', createdAt: NOW_ISO })).api);
    expect(host.querySelector('[data-testid="dossier-overview"]')).toBeNull();
    // 概览区一条 <dt> 都不该有（「规模」三个字只出现在下面的编辑表单标签里）
    expect(host.querySelectorAll('.dossier__overview-row dt')).toHaveLength(0);
  });

  it('★ 员工口碑与面试体感两个标签分开显示', () => {
    const db = buildDB({
      id: 'c1',
      name: '字节跳动',
      shortName: '字节',
      industry: '互联网',
      scale: '10000 人以上',
      financingStage: 'listed',
      impression: '面试官很客气',
      employeeReview: '加班多但成长快',
      createdAt: NOW_ISO,
    });
    render(harness(db).api);
    const overview = host.querySelector('[data-testid="dossier-overview"]')!;
    const text = overview.textContent ?? '';
    expect(text).toContain('面试体感');
    expect(text).toContain('员工口碑');
    expect(text).toContain('已上市');
    expect(text).toContain('10000 人以上');
  });

  it('小计与投递列表来自真实数据，点岗位名进详情', () => {
    const h = harness(buildDB({ id: 'c1', name: '字节跳动', createdAt: NOW_ISO }));
    render(h.api);
    const stats = host.querySelector('[data-testid="dossier-stats"]')!.textContent ?? '';
    expect(stats).toContain('投递');
    click([...host.querySelectorAll('.dossier__apps button')].find((btn) => btn.textContent === '抖音前端') ?? null);
    expect(h.calls).toContain('open:a1');
  });

  it('★ 已删除的投递不进档案', () => {
    const db = buildDB({ id: 'c1', name: '字节跳动', createdAt: NOW_ISO });
    db.applications[0].deletedAt = '2026-10-30T00:00:00.000Z';
    render(harness(db).api);
    expect(host.textContent).not.toContain('抖音前端');
    expect(host.textContent).toContain('飞书前端');
  });

  it('时间轴按倒序渲染，system note 不加类型前缀', () => {
    const db = buildDB({ id: 'c1', name: '字节跳动', createdAt: NOW_ISO });
    db.notes.push({
      id: 'n2',
      applicationId: 'a2',
      type: 'system',
      content: '状态推进到「面试中」',
      auto: true,
      touchedAt: '2026-10-09T10:00:00.000Z',
    });
    render(harness(db).api);
    const items = [...host.querySelectorAll('.dossier__tl-item')].map((item) => item.textContent ?? '');
    expect(items[0]).toContain('状态推进到「面试中」');
    expect(items[1]).toContain('HR 说下周给答复');
  });

  it('★ 面经跳题库把原始 companyName 带走（COM-3 同口径）', () => {
    const h = harness(buildDB({ id: 'c1', name: '字节跳动', createdAt: NOW_ISO }));
    render(h.api);
    expect(host.textContent).toContain('共 1 题，1 题还没掌握');
    click([...host.querySelectorAll('button')].find((btn) => btn.textContent === '去题库复习这批题') ?? null);
    expect(h.calls).toContain('bank:字节跳动');
  });

  it('五字段就地编辑：填规模走 saveExtras，清空传 undefined（不写空串）', () => {
    const h = harness(
      buildDB({ id: 'c1', name: '字节跳动', scale: '1000-9999 人', createdAt: NOW_ISO }),
    );
    render(h.api);
    const input = [...host.querySelectorAll('.dossier__fields input')].find(
      (el) => (el as HTMLInputElement).value === '1000-9999 人',
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      // React 17+ 的 onBlur 实际监听 focusout（blur 本身不冒泡）
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(h.calls).toContain('extras:c1:{}');
  });

  it('关闭按钮调 closeDossier', () => {
    const h = harness(buildDB({ id: 'c1', name: '字节跳动', createdAt: NOW_ISO }));
    render(h.api);
    click(host.querySelector('button[aria-label="关闭"]'));
    expect(h.calls).toContain('close');
  });
});
