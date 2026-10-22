// @vitest-environment jsdom
/**
 * BoardView v0.8 管线 UI 测试（沿用 ErrorBoundary.test.tsx 的裸 react-dom + act 模式，
 * 不引入 testing-library —— 与项目「零新依赖」纪律一致）。
 *
 * 覆盖（PRD 验收 1/3/6 的看板部分）：
 * - 7 主动列，「已笔试」插在「已沟通」与「已约面」之间
 * - kebab 菜单改状态到「已笔试」→ changeStatus('written') + DropPanel 写笔试 Interview（round=0）
 * - 已约面面板：默认轮次 = 已有场数 + 1，类型可选，提交写结构化 Interview（F8 修复）
 * - 面试段三列一键收纳为计数 chip（默认展开）
 * - 轮次徽章「第 2 轮 · HR 面」出现在「面试中」列卡片上
 *
 * ⌘Z 撤销断言在 rules.test.ts（revertStatusChange 纯函数层）—— App 级键盘接线是既有代码。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardView } from './BoardView';
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

/** 只 mock BoardView 用到的入口；其余字段组件不应触碰 */
function makeApi(db: DB): AppApi {
  return {
    db,
    now: NOW,
    view: 'board',
    selectedId: null,
    highlightedId: null,
    openDetail: vi.fn(),
    openNew: vi.fn(),
    changeStatus: vi.fn(),
    addNote: vi.fn(),
    addInterview: vi.fn(),
    toast: vi.fn(),
  } as unknown as AppApi;
}

/** React 受控 input 的原生 value 写入（直接赋值不会触发 onChange） */
function setNativeValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('BoardView v0.8（jsdom）', () => {
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

  async function renderBoard(db: DB): Promise<AppApi> {
    const api = makeApi(db);
    root = createRoot(container);
    await act(async () => {
      root.render(<BoardView api={api} />);
    });
    return api;
  }

  const buttonByText = (text: string): HTMLButtonElement | undefined =>
    Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes(text));

  it('7 主动列，「已笔试」插在「已沟通」与「已约面」之间', async () => {
    await renderBoard(makeDb([makeApp()]));
    const names = Array.from(container.querySelectorAll('.board__col-name')).map((el) => el.textContent);
    expect(names).toEqual(['想投', '已投递', '已沟通', '已笔试', '已约面', '面试中', '已发 Offer', '已结束 ▸']);
  });

  it('★ kebab 改状态到「已笔试」→ changeStatus(written)，面板提交写笔试 Interview（round=0, kind=written）', async () => {
    const api = await renderBoard(makeDb([makeApp({ status: 'chatting' })]));

    await act(async () => {
      buttonByText('⋯')?.click();
    });
    const written = buttonByText('已笔试');
    expect(written).toBeDefined();
    await act(async () => {
      written?.click();
    });
    expect(api.changeStatus).toHaveBeenCalledWith('app-1', 'written');

    // DropPanel：笔试轮次固定 0、类型固定 written，直接「记下」
    expect(container.textContent).toContain('已改为');
    const roundInput = container.querySelector<HTMLInputElement>('.drop-panel input[type="number"]');
    expect(roundInput?.disabled).toBe(true);
    expect(roundInput?.value).toBe('0');
    await act(async () => {
      buttonByText('记下')?.click();
    });
    expect(api.addInterview).toHaveBeenCalledTimes(1);
    expect(api.addInterview).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: 'app-1', round: 0, kind: 'written', result: 'pending' }),
    );
  });

  it('★ F8 修复：落「已约面」提交后是结构化 Interview（round/kind），不再是 memo 字符串', async () => {
    // 一面(tech)已过 → 约二面：面板默认轮次 = 已有场数 + 1 = 2
    const api = await renderBoard(
      makeDb([makeApp({ status: 'chatting' })], [
        makeInterview({ id: 'iv-1', round: 1, kind: 'tech', result: 'passed' }),
      ]),
    );

    await act(async () => {
      buttonByText('⋯')?.click();
    });
    await act(async () => {
      buttonByText('已约面')?.click();
    });
    const kindSelect = container.querySelector<HTMLSelectElement>('.drop-panel select');
    expect(kindSelect).toBeDefined();
    await act(async () => {
      setNativeValue(kindSelect!, 'hr');
    });
    await act(async () => {
      buttonByText('记下')?.click();
    });
    expect(api.addInterview).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: 'app-1', round: 2, kind: 'hr', result: 'pending' }),
    );
    // 备注为空 → 不造假 memo
    expect(api.addNote).not.toHaveBeenCalled();
  });

  it('面试段三列一键收纳为计数 chip（默认展开），收纳后卡片隐藏、仍可展开', async () => {
    await renderBoard(
      makeDb(
        [makeApp({ id: 'w', status: 'written' }), makeApp({ id: 's', status: 'scheduled' })],
        [makeInterview({ id: 'iv-w', applicationId: 'w', round: 0, kind: 'written' })],
      ),
    );
    expect(container.querySelectorAll('.board__col--folded')).toHaveLength(0);
    expect(container.textContent).toContain('某某科技');

    await act(async () => {
      buttonByText('收纳面试段')?.click();
    });
    expect(container.querySelectorAll('.board__col--folded')).toHaveLength(3);
    // 已笔试 / 已约面 两列的卡片被收起（面试中列的空态也一并隐藏）
    expect(container.textContent).not.toContain('前端实习');

    await act(async () => {
      buttonByText('展开面试段')?.click();
    });
    expect(container.querySelectorAll('.board__col--folded')).toHaveLength(0);
    expect(container.textContent).toContain('前端实习');
  });

  it('★ 「面试中」列卡片显示轮次徽章「第 2 轮 · HR 面」', async () => {
    await renderBoard(
      makeDb([makeApp({ status: 'interviewing' })], [
        makeInterview({ id: 'iv-1', round: 1, kind: 'tech', result: 'passed' }),
        makeInterview({ id: 'iv-2', round: 2, kind: 'hr', result: 'pending', scheduledAt: '2026-10-22T10:00:00.000Z' }),
      ]),
    );
    const card = container.querySelector('.app-card');
    expect(card?.textContent).toContain('第 2 轮 · HR 面');
  });

  it('「已约面」列但轮次数据是老备份形状（无 pending 面试）→ 不显示徽章、不报错', async () => {
    await renderBoard(
      makeDb([makeApp({ status: 'scheduled' })], [
        makeInterview({ id: 'iv-1', round: 1, result: 'passed' }),
      ]),
    );
    expect(container.querySelector('.badge--round')).toBeNull();
  });
});
