// @vitest-environment jsdom
/**
 * 诊断报告历史（v0.9.1 / R-AI-10 的 UI 侧）。
 *
 * 这一组守四件事：
 * 1. **只有 1 份时连表头都不渲染** —— 「1/1」和两个永远点不动的按钮只是噪音；
 * 2. **切换而不是并排**：`‹ ›` 换的是同一块位置，同时只渲染一份报告；
 * 3. **删除两步且说清不可撤销**，且删的是「正在看的这一份」（不是最新那份）；
 * 4. **配额将满时给出读数**（190/200），不能等撞墙才说。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppApi } from '../../lib/api';
import type { AIReport, DB } from '../../types';
import { AI_REPORT_LIMIT } from '../../types';
import { emptyDB } from '../../lib/defaults';
import { ReportHistory } from './ReportHistory';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RESUME = 'res-1';

function makeReport(id: string, minute: number, targetId = RESUME): AIReport {
  return {
    id,
    pluginId: 'builtin:d19-diag',
    targetType: 'resume_diagnosis',
    targetId,
    content: `报告正文 ${id}`,
    scoreLocal: 60,
    createdAt: new Date(Date.UTC(2026, 2, 1, 0, minute)).toISOString(),
  };
}

function makeApi(reports: AIReport[]): { api: AppApi; remove: ReturnType<typeof vi.fn> } {
  const db: DB = emptyDB();
  db.aiReports = reports;
  const remove = vi.fn();
  const api = { db, now: new Date('2026-03-02T00:00:00.000Z'), deleteReport: remove } as unknown as AppApi;
  return { api, remove };
}

describe('ReportHistory（jsdom）', () => {
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
      root.render(<ReportHistory api={api} resumeId={RESUME} />);
    });
  }

  const buttons = (): HTMLButtonElement[] => Array.from(container.querySelectorAll('button'));
  const button = (text: string): HTMLButtonElement => {
    const found = buttons().find((item) => item.textContent?.includes(text));
    if (!found) throw new Error(`找不到按钮：${text}`);
    return found;
  };
  const byLabel = (label: string): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

  it('没有报告 → 整段不渲染', async () => {
    const { api } = makeApi([]);
    await render(api);
    expect(container.innerHTML).toBe('');
  });

  it('★ 只有 1 份 → 直接显示报告卡，**不渲染**切换栏（与 v0.9 的样子一致）', async () => {
    const { api } = makeApi([makeReport('rep-1', 1)]);
    await render(api);
    expect(container.querySelector('.report-history__bar')).toBeNull();
    expect(container.textContent).toContain('报告正文 rep-1');
    expect(container.textContent).not.toContain('1/1');
  });

  it('★ 3 份 → 切换栏出现，默认看最新的第 1/3 份，同时只渲染一份正文', async () => {
    const { api } = makeApi([makeReport('rep-1', 1), makeReport('rep-2', 2), makeReport('rep-3', 3)]);
    await render(api);

    expect(container.querySelector('.report-history__bar')).not.toBeNull();
    expect(container.querySelector('.report-history__count')?.textContent).toBe('1/3');
    expect(container.textContent).toContain('报告正文 rep-3');
    expect(container.textContent).not.toContain('报告正文 rep-1');
  });

  it('★ 「下一份」换到更早那一份，计数与正文一起变；到头后按钮禁用', async () => {
    const { api } = makeApi([makeReport('rep-1', 1), makeReport('rep-2', 2), makeReport('rep-3', 3)]);
    await render(api);

    await act(async () => byLabel('下一份报告').click());
    expect(container.querySelector('.report-history__count')?.textContent).toBe('2/3');
    expect(container.textContent).toContain('报告正文 rep-2');

    await act(async () => byLabel('下一份报告').click());
    expect(container.querySelector('.report-history__count')?.textContent).toBe('3/3');
    expect(container.textContent).toContain('报告正文 rep-1');
    expect(byLabel('下一份报告').disabled).toBe(true);

    // 回到最新那一份，往回走的按钮到头也禁用
    await act(async () => byLabel('上一份报告').click());
    await act(async () => byLabel('上一份报告').click());
    expect(byLabel('上一份报告').disabled).toBe(true);
  });

  it('★ 删除两步：第一次点只出说明（含「不可撤销」），确认后删的是当前这一份', async () => {
    const { api, remove } = makeApi([makeReport('rep-1', 1), makeReport('rep-2', 2)]);
    await render(api);

    await act(async () => byLabel('下一份报告').click()); // 现在看的是 rep-1（较早那份）
    await act(async () => button('删除这份').click());
    expect(remove).not.toHaveBeenCalled();
    expect(container.textContent).toContain('不可撤销');

    await act(async () => button('确认永久删除').click());
    expect(remove).toHaveBeenCalledWith('rep-1');
  });

  it('取消删除 → 说明收起，一次都没删', async () => {
    const { api, remove } = makeApi([makeReport('rep-1', 1), makeReport('rep-2', 2)]);
    await render(api);

    await act(async () => button('删除这份').click());
    expect(container.textContent).toContain('不可撤销');
    await act(async () => button('取消').click());
    expect(container.textContent).not.toContain('不可撤销');
    expect(remove).not.toHaveBeenCalled();
  });

  it('★ 换一份时二次确认自动收起（否则「确认删除」会跟着跑到另一份下面）', async () => {
    const { api } = makeApi([makeReport('rep-1', 1), makeReport('rep-2', 2)]);
    await render(api);

    await act(async () => button('删除这份').click());
    expect(container.textContent).toContain('不可撤销');
    await act(async () => byLabel('下一份报告').click());
    expect(container.textContent).not.toContain('不可撤销');
  });

  it('配额将满（≥ 上限 − 10）→ 显示「全库报告 N/200」读数', async () => {
    const reports: AIReport[] = [makeReport('rep-1', 1)];
    for (let i = 0; i < AI_REPORT_LIMIT - 10; i += 1) reports.push(makeReport(`fill-${i}`, 2, `other-${i}`));
    const { api } = makeApi(reports);
    await render(api);

    expect(container.textContent).toContain(`全库报告 ${AI_REPORT_LIMIT - 9}/${AI_REPORT_LIMIT}`);
    expect(container.textContent).not.toContain('已满 ——');
  });

  it('配额已满 → 读数后面追加「已满，先删几份」的处置指引', async () => {
    const reports: AIReport[] = [makeReport('rep-1', 1)];
    for (let i = 0; i < AI_REPORT_LIMIT - 1; i += 1) reports.push(makeReport(`fill-${i}`, 2, `other-${i}`));
    const { api } = makeApi(reports);
    await render(api);

    expect(container.textContent).toContain(`全库报告 ${AI_REPORT_LIMIT}/${AI_REPORT_LIMIT}`);
    expect(container.textContent).toContain('先删几份旧的才能继续生成');
  });
});
