// @vitest-environment jsdom
/**
 * DetailDrawer v0.8 管线 UI 测试（裸 react-dom + act，同 ErrorBoundary 模式）。
 *
 * 覆盖（PRD 验收 2/3/6 的详情抽屉部分）：
 * - 面试表单「类型」下拉：笔试固定 round=0 不可改，提交写 kind='written' 并把早期状态推到 written
 * - 一面(tech)过 → 约二面(hr)：提交写 Interview{round:2, kind:'hr'}，状态推到 scheduled
 * - 老备份（无轮次数据）→ 「轮次未记」文案出现，不报错（验收 6）
 * - P1 R-PIPE-7：interviewing/scheduled 且无 Interview 记录 → 补录引导（可忽略）
 * - 笔试挂（rejectedAtRound=0）→ 挂点 chip 显示「笔试」且为已记样式（不再是琥珀色待补录）
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DetailDrawer } from './DetailDrawer';
import type { AppApi } from '../lib/api';
import { emptyDB } from '../lib/defaults';
import type { Application, DB, Interview } from '../types';

const NOW = new Date(2026, 9, 20, 10, 0, 0);

function makeApp(overrides: Partial<Application> = {}): Application {
  return {
    id: 'app-1',
    companyId: 'c-1',
    jobTitle: '前端实习',
    status: 'chatting',
    statusChangedAt: '2026-10-19T01:00:00.000Z',
    lastActivityAt: '2026-10-19T01:00:00.000Z',
    createdAt: '2026-10-19T01:00:00.000Z',
    updatedAt: '2026-10-19T01:00:00.000Z',
    rejectedAtRound: null,
    ...overrides,
  };
}

function makeInterview(overrides: Partial<Interview> = {}): Interview {
  return {
    id: 'iv-1',
    applicationId: 'app-1',
    round: 1,
    scheduledAt: '2026-10-18T10:00:00.000Z',
    format: 'video',
    result: 'pending',
    ...overrides,
  };
}

function makeDb(apps: Application[], interviews: Interview[] = []): DB {
  const db = emptyDB();
  db.companies = [{ id: 'c-1', name: '某某科技', createdAt: '2026-10-01T00:00:00.000Z' }];
  db.applications = apps;
  db.interviews = interviews;
  return db;
}

function makeApi(db: DB): AppApi {
  return {
    db,
    now: NOW,
    view: 'board',
    selectedId: 'app-1',
    highlightedId: null,
    closeDetail: vi.fn(),
    openDetail: vi.fn(),
    openNew: vi.fn(),
    changeStatus: vi.fn(),
    addNote: vi.fn(),
    deleteNote: vi.fn(),
    addInterview: vi.fn(),
    updateInterview: vi.fn(),
    deleteInterview: vi.fn(),
    updateApplication: vi.fn(),
    updateCompany: vi.fn(),
    updateSettings: vi.fn(),
    deleteApplication: vi.fn(),
    openExperience: vi.fn(),
    openQuickNote: vi.fn(),
    toast: vi.fn(),
  } as unknown as AppApi;
}

/** React 受控 select 的原生写入（直接赋值不会触发 onChange） */
function setSelect(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('DetailDrawer v0.8（jsdom）', () => {
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

  async function renderDrawer(db: DB): Promise<AppApi> {
    const api = makeApi(db);
    root = createRoot(container);
    await act(async () => {
      root.render(<DetailDrawer api={api} />);
    });
    return api;
  }

  const buttonByText = (text: string): HTMLButtonElement | undefined =>
    Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes(text));

  /** 面试表单里的「类型」select：唯一带有「笔试」option 的那个 */
  const kindSelect = (): HTMLSelectElement | undefined =>
    Array.from(container.querySelectorAll<HTMLSelectElement>('.interview-form select')).find((select) =>
      Array.from(select.options).some((option) => option.value === 'written'),
    );

  it('老备份形状（无面试记录）→ 显示「轮次未记」与补录引导，不报错（验收 6 + R-PIPE-7）', async () => {
    await renderDrawer(makeDb([makeApp({ status: 'interviewing' })]));
    expect(container.textContent).toContain('当前轮次');
    expect(container.textContent).toContain('轮次未记');
    expect(container.textContent).toContain('补一下');
  });

  it('★ 表单类型选「笔试」→ 轮次锁 0，提交写 Interview{round:0, kind:written} 且状态推到 written', async () => {
    const api = await renderDrawer(makeDb([makeApp({ status: 'chatting' })]));

    await act(async () => {
      buttonByText('＋ 加一场')?.click();
    });
    const select = kindSelect();
    expect(select).toBeDefined();
    await act(async () => {
      setSelect(select!, 'written');
    });
    const roundInput = container.querySelector<HTMLInputElement>('.interview-form input[type="number"]');
    expect(roundInput?.disabled).toBe(true);
    expect(roundInput?.value).toBe('0');

    await act(async () => {
      buttonByText('保存面试')?.click();
    });
    expect(api.addInterview).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: 'app-1', round: 0, kind: 'written', result: 'pending' }),
    );
    expect(api.changeStatus).toHaveBeenCalledWith('app-1', 'written');
  });

  it('★ 一面(tech)过 → 约二面(hr)：提交写 Interview{round:2, kind:hr}，状态推到 scheduled（验收 3）', async () => {
    const api = await renderDrawer(
      makeDb([makeApp({ status: 'chatting' })], [
        makeInterview({ id: 'iv-1', round: 1, kind: 'tech', result: 'passed' }),
      ]),
    );

    await act(async () => {
      buttonByText('＋ 加一场')?.click();
    });
    await act(async () => {
      setSelect(kindSelect()!, 'hr');
    });
    const roundInput = container.querySelector<HTMLInputElement>('.interview-form input[type="number"]');
    expect(roundInput?.value).toBe('2');
    await act(async () => {
      buttonByText('保存面试')?.click();
    });
    expect(api.addInterview).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: 'app-1', round: 2, kind: 'hr', result: 'pending' }),
    );
    expect(api.changeStatus).toHaveBeenCalledWith('app-1', 'scheduled');
  });

  it('有轮次数据时「当前轮次」显示徽章口径文案（第 2 轮 · HR 面）', async () => {
    await renderDrawer(
      makeDb([makeApp({ status: 'interviewing' })], [
        makeInterview({ id: 'iv-1', round: 1, kind: 'tech', result: 'passed' }),
        makeInterview({ id: 'iv-2', round: 2, kind: 'hr', result: 'pending' }),
      ]),
    );
    expect(container.textContent).toContain('第 2 轮 · HR 面');
  });

  it('★ 笔试挂（rejectedAtRound=0）→ 挂点 chip 显示「笔试」且为已记样式，不再当待补录（验收 2）', async () => {
    await renderDrawer(makeDb([makeApp({ status: 'rejected', rejectedAtRound: 0 })]));
    const chip = Array.from(container.querySelectorAll('button.chip')).find((el) => el.textContent === '笔试');
    expect(chip).toBeDefined();
    expect(chip?.className).toContain('chip--quiet');
    expect(chip?.className).not.toContain('chip--amber');
  });

  it('面试卡片：round=0（笔试记录）显示「笔试」而不是「第 0 轮」', async () => {
    await renderDrawer(
      makeDb([makeApp({ status: 'written' })], [
        makeInterview({ id: 'iv-0', round: 0, kind: 'written' }),
      ]),
    );
    expect(container.textContent).toContain('笔试');
    expect(container.textContent).not.toContain('第 0 轮');
  });
});
