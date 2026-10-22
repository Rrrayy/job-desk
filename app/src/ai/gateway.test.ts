/**
 * gateway 单测（v0.8 / T03，ARCH §1.4 验收 ③）。
 *
 * 全部走 `_fetchImpl` 注入的 mock，零真实网络。覆盖：
 * - SSE 解析：多 delta 拼接、onDelta 逐段回调、[DONE] 结束、finish_reason 提取
 * - 请求体形状：URL 拼接 / method / body{model,messages,stream} / Bearer 头有无
 * - 超时：连接 10s、总 60s（fake timers）
 * - 重试：5xx 与 network 退避重试 ≤2；4xx / 超时 / 取消 / parse 不重试
 * - 非 stream：一次性 JSON 响应
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECT_TIMEOUT_MS,
  GatewayError,
  RETRY_DELAYS_MS,
  TOTAL_TIMEOUT_MS,
  chatCompletions,
  endpointOf,
} from './gateway';
import type { AISettings } from '../types';

const SETTINGS: AISettings = { baseURL: 'http://127.0.0.1:11434/v1/', model: 'qwen2.5:7b', isLocal: true };
const MESSAGES = [
  { role: 'system' as const, content: 'sys' },
  { role: 'user' as const, content: 'hi' },
];

function encoder(): TextEncoder {
  return new TextEncoder();
}

/** mock 的调用记录：次数与最后一次的 RequestInit（断言请求体形状用） */
interface Capture {
  calls: number;
  init?: RequestInit;
}

/** SSE mock：按行灌进一个 ReadableStream */
function sseFetch(lines: string[], capture?: Capture): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (capture) {
      capture.calls += 1;
      capture.init = init;
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder().encode(line));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
}

function deltaLine(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('gateway · 请求体形状', () => {
  it('URL 拼接：baseURL 去尾斜杠 + /chat/completions', () => {
    expect(endpointOf('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(endpointOf('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234/v1/chat/completions');
  });

  it('body 恒为 {model, messages, stream:true}；无 apiKey 不带 Authorization', async () => {
    const capture: Capture = { calls: 0 };
    const done = chatCompletions(SETTINGS, { messages: MESSAGES }, sseFetch([deltaLine('a'), 'data: [DONE]\n\n'], capture));
    await vi.advanceTimersByTimeAsync(0);
    const result = await done;
    expect(result.text).toBe('a');
    expect(capture.calls).toBe(1);
    const init = capture.init as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ model: 'qwen2.5:7b', messages: MESSAGES, stream: true });
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('有 apiKey 时带 Bearer 头', async () => {
    const capture: Capture = { calls: 0 };
    const done = chatCompletions(
      { ...SETTINGS, apiKey: 'sk-test' },
      { messages: MESSAGES },
      sseFetch([deltaLine('x'), 'data: [DONE]\n\n'], capture),
    );
    await vi.advanceTimersByTimeAsync(0);
    await done;
    expect((capture.init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-test' });
  });

  it('未配置 baseURL / model 直接拒绝，不发请求', async () => {
    await expect(chatCompletions({ ...SETTINGS, baseURL: '' }, { messages: MESSAGES })).rejects.toMatchObject({
      code: 'network',
    });
    await expect(chatCompletions({ ...SETTINGS, model: '' }, { messages: MESSAGES })).rejects.toMatchObject({
      code: 'network',
    });
  });
});

describe('gateway · SSE 解析', () => {
  it('多 delta 拼接 + onDelta 逐段回调 + finish_reason', async () => {
    const deltas: string[] = [];
    const lines = [
      deltaLine('你好'),
      deltaLine('，世'),
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n',
      'data: [DONE]\n\n',
    ];
    const done = chatCompletions(SETTINGS, { messages: MESSAGES, onDelta: (d) => deltas.push(d) }, sseFetch(lines));
    await vi.advanceTimersByTimeAsync(0);
    const result = await done;
    expect(result.text).toBe('你好，世');
    expect(result.finishReason).toBe('stop');
    expect(deltas).toEqual(['你好', '，世']);
  });

  it('非 data 行与空行被跳过，不炸流', async () => {
    const lines = [': keep-alive\n\n', deltaLine('ok'), '\n\n', 'data: [DONE]\n\n'];
    const done = chatCompletions(SETTINGS, { messages: MESSAGES }, sseFetch(lines));
    await vi.advanceTimersByTimeAsync(0);
    expect((await done).text).toBe('ok');
  });

  it('SSE 行不是 JSON → parse 错误，不重试', async () => {
    const capture: Capture = { calls: 0 };
    const done = chatCompletions(
      SETTINGS,
      { messages: MESSAGES },
      sseFetch(['data: {broken\n\n'], capture),
    );
    // 先挂断言再推进： rejection 发生在微任务里，晚挂会变 unhandled rejection
    const assertion = expect(done).rejects.toMatchObject({ code: 'parse' });
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
    expect(capture.calls).toBe(1);
  });

  it('stream:false 走一次性 JSON 响应', async () => {
    const mock = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '整段回答' }, finish_reason: 'stop' }] }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const capture: Capture = { calls: 0 };
    const done = chatCompletions(SETTINGS, { messages: MESSAGES, stream: false }, (input, init) => {
      capture.calls += 1;
      capture.init = init;
      return mock(input, init);
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await done;
    expect(result.text).toBe('整段回答');
    expect(result.finishReason).toBe('stop');
    expect(JSON.parse((capture.init as RequestInit).body as string)).toMatchObject({ stream: false });
  });
});

describe('gateway · 超时（双 timer）', () => {
  /** 永不返回、但尊重 abort 信号的 mock */
  function neverFetch(): typeof fetch {
    return ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch;
  }

  it('连接超时 10s → timeout，且不重试', async () => {
    const capture: Capture = { calls: 0 };
    const mock = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capture.calls += 1;
      return (neverFetch()(input, init) as Promise<Response>);
    };
    const done = chatCompletions(SETTINGS, { messages: MESSAGES }, mock as unknown as typeof fetch);
    const assertion = expect(done).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    await assertion;
    expect(capture.calls).toBe(1);
  });

  it('总超时 60s：响应头到了但流卡死 → timeout', async () => {
    const mock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder().encode(deltaLine('部分')));
          init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
          // 永不 close —— 模拟服务端挂起
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    const done = chatCompletions(SETTINGS, { messages: MESSAGES }, mock);
    const assertion = expect(done).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(TOTAL_TIMEOUT_MS);
    await assertion;
  });

  it('调用方取消（signal）→ 不重试直接退出', async () => {
    const capture: Capture = { calls: 0 };
    const controller = new AbortController();
    /** 挂起直到 signal 中止 —— 保证 abort 时请求仍在途 */
    const hangFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        capture.calls += 1;
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch;
    const done = chatCompletions(SETTINGS, { messages: MESSAGES, signal: controller.signal }, hangFetch);
    const assertion = expect(done).rejects.toMatchObject({ code: 'network' });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
    expect(capture.calls).toBe(1);
  });
});

describe('gateway · 重试（5xx / network，退避 ≤2 次）', () => {
  it('5xx → 退避 1s、2s 重试，第三次成功', async () => {
    const capture: Capture = { calls: 0 };
    const mock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capture.calls += 1;
      if (capture.calls <= 2) return new Response('server busy', { status: 503 });
      return sseFetch([deltaLine('ok'), 'data: [DONE]\n\n'])(input, init);
    }) as unknown as typeof fetch;
    const done = chatCompletions(SETTINGS, { messages: MESSAGES }, mock);
    const assertion = expect(done).resolves.toMatchObject({ text: 'ok' });
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] + RETRY_DELAYS_MS[1]);
    await assertion;
    expect(capture.calls).toBe(3);
  });

  it('network 错误同样重试；两次重试仍失败 → 抛最后一个 network', async () => {
    const capture: Capture = { calls: 0 };
    const mock = (async () => {
      capture.calls += 1;
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const done = chatCompletions(SETTINGS, { messages: MESSAGES }, mock);
    const assertion = expect(done).rejects.toBeInstanceOf(GatewayError);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] + RETRY_DELAYS_MS[1]);
    await assertion;
    expect(capture.calls).toBe(3);
  });

  it('4xx 不重试（401 直接抛 http）', async () => {
    const capture: Capture = { calls: 0 };
    const mock = (async () => {
      capture.calls += 1;
      return new Response('unauthorized', { status: 401 });
    }) as unknown as typeof fetch;
    const done = chatCompletions(SETTINGS, { messages: MESSAGES }, mock);
    const assertion = expect(done).rejects.toMatchObject({ code: 'http', status: 401 });
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] + RETRY_DELAYS_MS[1]);
    await assertion;
    expect(capture.calls).toBe(1);
  });
});
