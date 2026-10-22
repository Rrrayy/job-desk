// @vitest-environment jsdom
/**
 * 编辑期写入通道（A-07）：`useResumeDraft` + 真·SchemaForm 的联通测试。
 *
 * 这是「防抖」这件事在真实组件树上唯一可信的证明：
 * 敲 5 个字 → `onCommit`（= `api.updateResumeContent` 的位置）**只被调用 1 次**，
 * 且值是最新那个。单独测 writer 只能证明计时器语义，证明不了
 * 「Field 的 live 提交 + 受控表单 + hook」串起来没有中间态丢字。
 */

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResumeContent, TemplateSectionSpec } from '../../types';
import { ensureSectionsWith } from '../../resume/schema';
import { useResumeDraft } from './useResumeDraft';
import { SchemaForm } from './SchemaForm';

const SCHEMA: TemplateSectionSpec[] = [
  { type: 'basics', repeatable: false, fields: [{ key: 'name' }, { key: 'email' }] },
  { type: 'skills', repeatable: false, fields: [{ key: 'skillsText' }] },
];

const INITIAL: ResumeContent = ensureSectionsWith({ sections: [] }, SCHEMA);

/** 只有「草稿 + 落库通道」，不回写 content（模拟 db 不变的最简宿主） */
function PlainHost({ onCommit }: { onCommit: (next: ResumeContent) => void }) {
  const { draft, update } = useResumeDraft({ content: INITIAL, onCommit });
  return <SchemaForm sections={SCHEMA} content={draft} onChange={update} />;
}

/** 真实宿主：落库会回写 content（与 App 里 `mutate` 后 db 换新对象一致） */
function LiveHost({
  onCommit,
  external,
}: {
  onCommit: (next: ResumeContent) => void;
  external: ResumeContent;
}) {
  const [dbContent, setDbContent] = useState<ResumeContent>(INITIAL);
  const { draft, update, flush } = useResumeDraft({
    content: dbContent,
    onCommit: (next) => {
      onCommit(next);
      setDbContent(next);
    },
  });
  return (
    <div>
      <SchemaForm sections={SCHEMA} content={draft} onChange={update} />
      <button type="button" aria-label="flush" onClick={() => flush()}>
        flush
      </button>
      <button type="button" aria-label="external" onClick={() => setDbContent(external)}>
        external
      </button>
    </div>
  );
}

describe('useResumeDraft（jsdom + fake timers）', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const proto =
      element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function nameInput(): HTMLInputElement {
    return container.querySelector<HTMLInputElement>('input[placeholder="例：张三"]')!;
  }

  function emailInput(): HTMLInputElement {
    return container.querySelector<HTMLInputElement>('input[placeholder="例：zhangsan@example.com"]')!;
  }

  it('★ 敲 5 个字 → 400 ms 后只落库 1 次，值是最后那一次（不是 5 次）', async () => {
    const onCommit = vi.fn();
    root = createRoot(container);
    await act(async () => root.render(<PlainHost onCommit={onCommit} />));

    for (const value of ['张', '张三', '张三丰', '张三丰·', '张三丰·前端']) {
      await act(async () => setValue(nameInput(), value));
      await act(async () => vi.advanceTimersByTime(60)); // 打字间隔 60 ms
    }
    expect(onCommit).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTime(400));

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0].sections[0].items[0].fields.name).toBe('张三丰·前端');
  });

  it('停手满 400 ms 之后再改另一个字段 → 第二次落库（不是把所有输入拼成一次）', async () => {
    const onCommit = vi.fn();
    root = createRoot(container);
    await act(async () => root.render(<PlainHost onCommit={onCommit} />));

    await act(async () => setValue(nameInput(), '张三'));
    await act(async () => vi.advanceTimersByTime(400));
    expect(onCommit).toHaveBeenCalledTimes(1);

    await act(async () => setValue(emailInput(), 'z@example.com'));
    await act(async () => vi.advanceTimersByTime(400));
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit.mock.calls[1][0].sections[0].items[0].fields.email).toBe('z@example.com');
    // 上一步的名字没丢（草稿是累积的整份内容，不是增量 patch）
    expect(onCommit.mock.calls[1][0].sections[0].items[0].fields.name).toBe('张三');
  });

  it('★ flush：立刻落库，且计时器到点不会再写第二遍（AI 写回前的关键语义）', async () => {
    const onCommit = vi.fn();
    root = createRoot(container);
    await act(async () => root.render(<LiveHost onCommit={onCommit} external={INITIAL} />));

    await act(async () => setValue(nameInput(), '张三'));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="flush"]')!.click();
    });
    expect(onCommit).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTime(1000));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('★ 外部内容替换（AI 写回 / 切模板）以外部为准：待提交草稿被丢弃，界面显示新值', async () => {
    const onCommit = vi.fn();
    const external: ResumeContent = {
      sections: [
        {
          id: 'sec-external',
          type: 'basics',
          items: [{ id: 'item-external', fields: { name: 'AI 写回的名字' } }],
        },
      ],
    };
    root = createRoot(container);
    await act(async () => root.render(<LiveHost onCommit={onCommit} external={external} />));

    await act(async () => setValue(nameInput(), '我刚打的字'));
    // 还没到 400 ms 就来了外部内容
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="external"]')!.click();
    });

    expect(nameInput().value).toBe('AI 写回的名字');

    // 旧草稿不能在这时候冒出来覆盖外部内容
    await act(async () => vi.advanceTimersByTime(1000));
    expect(onCommit).not.toHaveBeenCalled();
    expect(nameInput().value).toBe('AI 写回的名字');
  });

  it('卸载时把最后 400 ms 的输入落库（切页不会白输）', async () => {
    const onCommit = vi.fn();
    root = createRoot(container);
    await act(async () => root.render(<PlainHost onCommit={onCommit} />));

    await act(async () => setValue(nameInput(), '来不及等防抖'));
    await act(async () => root.unmount());

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0].sections[0].items[0].fields.name).toBe('来不及等防抖');
  });
});
