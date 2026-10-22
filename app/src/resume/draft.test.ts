/**
 * 草稿写入通道的语义（ARCH A-07）。
 *
 * 这一层的每条断言都对应一个用户能感知的后果：
 * - 只写最后一次 → 500 条投递时输入不卡（逐字克隆整库会卡出可见掉帧）；
 * - flush 会清计时器 → AI 写回后不会再来一次「迟到的旧草稿」覆盖；
 * - cancel 后到点不写 → 外部内容（AI / 切模板）才是真相。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDraftWriter, DRAFT_DEBOUNCE_MS } from './draft';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createDraftWriter：最后一次赢', () => {
  it('默认延迟是 400 ms', () => {
    expect(DRAFT_DEBOUNCE_MS).toBe(400);
  });

  it('★ 400 ms 内连打 5 次 → 只落库 1 次，值是最后一次', () => {
    const commit = vi.fn();
    const writer = createDraftWriter<string>(commit);

    writer.schedule('张');
    vi.advanceTimersByTime(80);
    writer.schedule('张三');
    vi.advanceTimersByTime(80);
    writer.schedule('张三丰');
    vi.advanceTimersByTime(80);
    writer.schedule('张三丰·前端');
    vi.advanceTimersByTime(80);
    writer.schedule('张三丰·前端开发');

    expect(commit).not.toHaveBeenCalled();
    expect(writer.pending()).toBe(true);

    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('张三丰·前端开发');
    expect(writer.pending()).toBe(false);
  });

  it('停手后再输入会重新计时（不会在窗口中间落库）', () => {
    const commit = vi.fn();
    const writer = createDraftWriter<string>(commit);

    writer.schedule('a');
    vi.advanceTimersByTime(399);
    writer.schedule('ab');
    vi.advanceTimersByTime(399);
    expect(commit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('ab');
  });

  it('★ flush 立刻写掉待提交值，且不会再被计时器写第二遍', () => {
    const commit = vi.fn();
    const writer = createDraftWriter<string>(commit);

    writer.schedule('草稿');
    writer.flush();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('草稿');

    // 关键：计时器必须已经清掉，否则 400 ms 后会再来一次
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS * 3);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(writer.pending()).toBe(false);
  });

  it('没有待提交值时 flush 是 no-op（打印前无脑调一次也不会写盘）', () => {
    const commit = vi.fn();
    const writer = createDraftWriter<string>(commit);
    writer.flush();
    expect(commit).not.toHaveBeenCalled();
  });

  it('★ cancel 之后计时器到点也不写（外部内容才是真相）', () => {
    const commit = vi.fn();
    const writer = createDraftWriter<string>(commit);

    writer.schedule('过期的草稿');
    writer.cancel();
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS * 2);

    expect(commit).not.toHaveBeenCalled();
    expect(writer.pending()).toBe(false);
  });

  it('可以注入自定义延迟（测试与将来的「保存后立即落库」档位用）', () => {
    const commit = vi.fn();
    const writer = createDraftWriter<string>(commit, 0);

    writer.schedule('立刻');
    vi.advanceTimersByTime(0);
    expect(commit).toHaveBeenCalledWith('立刻');
  });

  it('flush 之后还能继续接收新的 schedule（不是一次性对象）', () => {
    const commit = vi.fn();
    const writer = createDraftWriter<string>(commit);

    writer.schedule('第一次');
    writer.flush();
    writer.schedule('第二次');
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);

    expect(commit.mock.calls).toEqual([['第一次'], ['第二次']]);
  });
});
