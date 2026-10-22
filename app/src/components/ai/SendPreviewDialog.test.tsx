// @vitest-environment jsdom
/**
 * D13 SendPreviewDialog 组件测试（v0.8 / T03，PRD 验收 8 的「双保险」）：
 * ① 快照进 CI —— 出境字段集合变了快照必炸，逼着开发者显式更新；
 * ② 显式基线断言 —— 不依赖快照实现细节：新增出境字段（轮次/面试类型/
 *    笔试结果/面经原文/沟通记录/原文片段之外的敏感内容）默认不勾选，
 *    companyName/jobTitle/status ∪ locked 默认勾选。
 *
 * 沿用裸 react-dom + act 模式，零 testing-library。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SendPreviewDialog } from './SendPreviewDialog';
import type { PreviewField } from '../../ai/types';

function field(name: string, label: string, value = '', locked = false): PreviewField {
  return { name, label, value, ...(locked ? { locked: true } : {}) };
}

const FIELDS: PreviewField[] = [
  field('companyName', '公司名', '字节跳动'),
  field('jobTitle', '岗位名', '前端实习生'),
  field('status', '当前状态', '面试中'),
  field('round', '当前轮次', '2'),
  field('interviewKind', '面试类型', 'HR 面'),
  field('writtenResult', '笔试结果', '通过'),
  field('note', '面经笔记原文', '问了我 fiber 架构……'),
  field('lastNote', '最近沟通记录', '上周约的二面……'),
  field('rawSnippet', '用户粘贴的原文片段', '字节 前端 25k', true),
];

describe('SendPreviewDialog（D13）', () => {
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

  async function renderDialog(overrides: Partial<Parameters<typeof SendPreviewDialog>[0]> = {}): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <SendPreviewDialog
          title="AI 补全暂存行"
          pluginId="builtin:d17"
          baseURL="http://127.0.0.1:11434/v1"
          model="qwen2.5:7b"
          isLocal
          fields={FIELDS}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
          {...overrides}
        />,
      );
    });
  }

  const checkboxOf = (name: string): HTMLInputElement | null =>
    container.querySelector<HTMLInputElement>(`[data-testid="preview-field-${name}"] input[type="checkbox"]`);

  const checkedNames = (): string[] =>
    FIELDS.filter((f) => checkboxOf(f.name)?.checked).map((f) => f.name);

  it('★ 默认勾选基线：companyName/jobTitle/status ∪ locked；新增出境字段默认不勾', async () => {
    await renderDialog();
    expect(checkedNames()).toEqual(['companyName', 'jobTitle', 'status', 'rawSnippet']);
  });

  it('★ 快照：默认状态整树进 CI（字段集变化必炸快照）', async () => {
    await renderDialog();
    expect(container.querySelector('[data-testid="send-preview"]')?.innerHTML).toMatchSnapshot();
  });

  it('锁定字段必发：勾选框禁用且恒勾', async () => {
    await renderDialog();
    const locked = checkboxOf('rawSnippet');
    expect(locked?.disabled).toBe(true);
    expect(locked?.checked).toBe(true);
  });

  it('isLocal 明示「本机端口，请求不出公网」+ 模型与端点', async () => {
    await renderDialog();
    const meta = container.querySelector('[data-testid="send-preview-meta"]');
    expect(meta?.textContent).toContain('qwen2.5:7b');
    expect(meta?.textContent).toContain('http://127.0.0.1:11434/v1');
    expect(meta?.textContent).toContain('本机端口，请求不出公网');
  });

  it('勾选默认不勾的字段 → onConfirm 只收到勾选字段 {name: value}', async () => {
    const onConfirm = vi.fn();
    await renderDialog({ onConfirm });
    await act(async () => {
      checkboxOf('round')?.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="send-preview-confirm"]')?.click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith({
      companyName: '字节跳动',
      jobTitle: '前端实习生',
      status: '面试中',
      round: '2',
      rawSnippet: '字节 前端 25k',
    });
  });

  it('无锁定字段时全部取消勾选 → 发送按钮禁用（空请求没有意义）', async () => {
    const noLocked = FIELDS.filter((f) => !f.locked);
    await renderDialog({ fields: noLocked });
    await act(async () => {
      for (const name of ['companyName', 'jobTitle', 'status']) checkboxOf(name)?.click();
    });
    const confirm = container.querySelector<HTMLButtonElement>('[data-testid="send-preview-confirm"]');
    expect(confirm?.disabled).toBe(true);
  });

  it('有锁定字段时不可能勾成空：其余全取消，锁定字段仍必发 → 按钮可用', async () => {
    await renderDialog();
    await act(async () => {
      for (const name of ['companyName', 'jobTitle', 'status']) checkboxOf(name)?.click();
    });
    const confirm = container.querySelector<HTMLButtonElement>('[data-testid="send-preview-confirm"]');
    expect(confirm?.disabled).toBe(false);
  });

  it('取消回调', async () => {
    const onCancel = vi.fn();
    await renderDialog({ onCancel });
    await act(async () => {
      Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '取消')?.click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
