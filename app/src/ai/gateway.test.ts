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
  TOTAL_TIMEOUT_MS,
  chatCompletions,
  endpointOf,
  probeConnection,
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

  it('body = {model, messages, stream, stream_options}；无参数时不出现 temperature 等键', async () => {
    const capture: Capture = { calls: 0 };
    const done = chatCompletions(SETTINGS, { messages: MESSAGES }, sseFetch([deltaLine('a'), 'data: [DONE]\n\n'], capture));
    await vi.advanceTimersByTimeAsync(0);
    const result = await done;
    expect(result.text).toBe('a');
    expect(capture.calls).toBe(1);
    const init = capture.init as RequestInit;
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      model: 'qwen2.5:7b',
      messages: MESSAGES,
      stream: true,
      stream_options: { include_usage: true },
    });
    // v0.10 铁律：没配置的参数一个都不许出现（不能悄悄塞一个 0.7）
    expect('temperature' in body).toBe(false);
    expect('top_p' in body).toBe(false);
    expect('max_tokens' in body).toBe(false);
    expect('response_format' in body).toBe(false);
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
    const assertion = expect(done).rejects.toMatchObject({ code: 'cancel' });
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
    await vi.advanceTimersByTimeAsync(6_000);
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
    await vi.advanceTimersByTimeAsync(6_000);
    await assertion;
    expect(capture.calls).toBe(3);
  });

  it('4xx 不重试（401 归为 auth）', async () => {
    const capture: Capture = { calls: 0 };
    const mock = (async () => {
      capture.calls += 1;
      return new Response('unauthorized', { status: 401 });
    }) as unknown as typeof fetch;
    const done = chatCompletions(SETTINGS, { messages: MESSAGES }, mock);
    const assertion = expect(done).rejects.toMatchObject({ code: 'auth', status: 401 });
    await vi.advanceTimersByTimeAsync(6_000);
    await assertion;
    expect(capture.calls).toBe(1);
  });
});

/* ==================== v0.10 / L1：参数注入、能力降级、推理模型、用量 ==================== */

/** 读取 mock 收到的请求体 */
function bodyOf(capture: Capture): Record<string, unknown> {
  return JSON.parse((capture.init as RequestInit).body as string) as Record<string, unknown>;
}

describe('gateway · 参数注入（缺省不发，配了才发）', () => {
  it('全局参数注入为 top_p / max_tokens（snake_case）', async () => {
    const capture: Capture = { calls: 0 };
    const done = chatCompletions(
      { ...SETTINGS, temperature: 0.3, topP: 0.9, maxTokens: 2048 },
      { messages: MESSAGES },
      sseFetch([deltaLine('a'), 'data: [DONE]\n\n'], capture),
    );
    await vi.advanceTimersByTimeAsync(0);
    await done;
    const body = bodyOf(capture);
    expect(body.temperature).toBe(0.3);
    expect(body.top_p).toBe(0.9);
    expect(body.max_tokens).toBe(2048);
  });

  it('场景覆盖优先于全局（解析类固定 0 度不被全局 0.8 盖掉）', async () => {
    const capture: Capture = { calls: 0 };
    const done = chatCompletions(
      { ...SETTINGS, temperature: 0.8, maxTokens: 4096 },
      { messages: MESSAGES, params: { temperature: 0 } },
      sseFetch([deltaLine('a'), 'data: [DONE]\n\n'], capture),
    );
    await vi.advanceTimersByTimeAsync(0);
    await done;
    const body = bodyOf(capture);
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(4096);
  });
});

describe('gateway · JSON 模式（auto / on / off）与自动降级', () => {
  it('auto 模式：场景显式要求才带 response_format', async () => {
    const capture: Capture = { calls: 0 };
    const done = chatCompletions(
      SETTINGS,
      { messages: MESSAGES, params: { jsonMode: true } },
      sseFetch([deltaLine('{}'), 'data: [DONE]\n\n'], capture),
    );
    await vi.advanceTimersByTimeAsync(0);
    await done;
    expect(bodyOf(capture).response_format).toEqual({ type: 'json_object' });
  });

  it('off 一票否决：场景要求也不带', async () => {
    const capture: Capture = { calls: 0 };
    const done = chatCompletions(
      { ...SETTINGS, jsonMode: 'off' },
      { messages: MESSAGES, params: { jsonMode: true } },
      sseFetch([deltaLine('{}'), 'data: [DONE]\n\n'], capture),
    );
    await vi.advanceTimersByTimeAsync(0);
    await done;
    expect('response_format' in bodyOf(capture)).toBe(false);
  });

  it('服务端 400 拒绝 response_format → 摘掉后重试成功（不计入重试次数）', async () => {
    const capture: Capture = { calls: 0 };
    const mock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capture.calls += 1;
      capture.init = init;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if ('response_format' in body) return new Response('response_format not supported', { status: 400 });
      return sseFetch([deltaLine('{"ok":1}'), 'data: [DONE]\n\n'])(input, init);
    }) as unknown as typeof fetch;
    const done = chatCompletions(SETTINGS, { messages: MESSAGES, params: { jsonMode: true } }, mock);
    await vi.advanceTimersByTimeAsync(0);
    await expect(done).resolves.toMatchObject({ text: '{"ok":1}' });
    expect(capture.calls).toBe(2);
  });
});

describe('gateway · 流式用量（stream_options 自动降级）', () => {
  it('末尾 chunk 的 usage 被收进结果', async () => {
    const lines = [
      deltaLine('你'),
      deltaLine('好'),
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const done = chatCompletions(SETTINGS, { messages: MESSAGES }, sseFetch(lines));
    await vi.advanceTimersByTimeAsync(0);
    const result = await done;
    expect(result.text).toBe('你好');
    expect(result.usage).toEqual({ prompt: 12, completion: 3, total: 15 });
  });

  it('服务端 400 拒绝 stream_options → 摘掉后重试成功', async () => {
    const capture: Capture = { calls: 0 };
    const mock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capture.calls += 1;
      capture.init = init;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if ('stream_options' in body) return new Response('unknown field stream_options', { status: 400 });
      return sseFetch([deltaLine('ok'), 'data: [DONE]\n\n'])(input, init);
    }) as unknown as typeof fetch;
    const done = chatCompletions(SETTINGS, { messages: MESSAGES }, mock);
    await vi.advanceTimersByTimeAsync(0);
    await expect(done).resolves.toMatchObject({ text: 'ok' });
    expect(capture.calls).toBe(2);
    expect('stream_options' in bodyOf(capture)).toBe(false);
  });
});

describe('gateway · 推理模型（reasoning_content）', () => {
  it('流式：思考过程不混进正文，但会被收下', async () => {
    const lines = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '想…' } }] })}\n\n`,
      deltaLine('答案'),
      'data: [DONE]\n\n',
    ];
    const done = chatCompletions(SETTINGS, { messages: MESSAGES }, sseFetch(lines));
    await vi.advanceTimersByTimeAsync(0);
    const result = await done;
    expect(result.text).toBe('答案');
    expect(result.reasoning).toBe('想…');
  });

  it('只有思考没有正文 → parse 错误，且提示是给用户看的', async () => {
    const lines = [`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '想了很久' } }] })}\n\n`, 'data: [DONE]\n\n'];
    const done = chatCompletions(SETTINGS, { messages: MESSAGES }, sseFetch(lines));
    const assertion = expect(done).rejects.toMatchObject({ code: 'parse' });
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
    await expect(done).rejects.toThrow(/只返回了思考过程/);
  });

  it('非流式：message.reasoning_content 同样兼容', async () => {
    const mock = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '正文', reasoning_content: '推理' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch;
    const done = chatCompletions(SETTINGS, { messages: MESSAGES, stream: false }, mock);
    await vi.advanceTimersByTimeAsync(0);
    const result = await done;
    expect(result.text).toBe('正文');
    expect(result.reasoning).toBe('推理');
    expect(result.usage).toEqual({ prompt: 5, completion: 2, total: 7 });
  });
});

describe('gateway · 限流（429 Retry-After）', () => {
  it('按服务端给的秒数退避，然后成功', async () => {
    const capture: Capture = { calls: 0 };
    const mock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capture.calls += 1;
      if (capture.calls === 1) {
        return new Response('slow down', { status: 429, headers: { 'Retry-After': '3' } });
      }
      return sseFetch([deltaLine('late'), 'data: [DONE]\n\n'])(input, init);
    }) as unknown as typeof fetch;
    const done = chatCompletions(SETTINGS, { messages: MESSAGES }, mock);
    const assertion = expect(done).resolves.toMatchObject({ text: 'late' });
    await vi.advanceTimersByTimeAsync(3_100);
    await assertion;
    expect(capture.calls).toBe(2);
  });

  it('404 归为 not_found 且不重试', async () => {
    const capture: Capture = { calls: 0 };
    const mock = (async () => {
      capture.calls += 1;
      return new Response('model not found', { status: 404 });
    }) as unknown as typeof fetch;
    const done = chatCompletions(SETTINGS, { messages: MESSAGES }, mock);
    const assertion = expect(done).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await vi.advanceTimersByTimeAsync(6_000);
    await assertion;
    expect(capture.calls).toBe(1);
  });
});

/* ==================== v0.10 / L1-2：连通性探针（只在点击时发生） ==================== */

describe('gateway · 连通性探针', () => {
  it('/models 成功 → ok + 模型列表 + via=models', async () => {
    const mock = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('http://127.0.0.1:11434/v1/models');
      return new Response(JSON.stringify({ data: [{ id: 'qwen2.5:7b' }, { id: 'llama3:8b' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const result = await probeConnection(SETTINGS, mock);
    expect(result.ok).toBe(true);
    expect(result.via).toBe('models');
    expect(result.models).toEqual(['qwen2.5:7b', 'llama3:8b']);
  });

  it('/models 404（自建网关常见）→ 退回最小 chat 探针', async () => {
    const calls: string[] = [];
    const mock = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/models')) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const result = await probeConnection(SETTINGS, mock);
    expect(result.ok).toBe(true);
    expect(result.via).toBe('chat');
    expect(calls).toHaveLength(2);
  });

  it('401 直接定性 auth，不再打第二次', async () => {
    let calls = 0;
    const mock = (async () => {
      calls += 1;
      return new Response('bad key', { status: 401 });
    }) as unknown as typeof fetch;
    const result = await probeConnection(SETTINGS, mock);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('auth');
    expect(calls).toBe(1);
  });

  it('地址为空 → 明确说没填地址，不发请求', async () => {
    let calls = 0;
    const mock = (async () => {
      calls += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const result = await probeConnection({ ...SETTINGS, baseURL: '' }, mock);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('服务地址');
    expect(calls).toBe(0);
  });

  it('/models 成功但没填模型名 → 仍算连上（模型名由就绪判定管）', async () => {
    const mock = (async () =>
      new Response(JSON.stringify({ data: [{ id: 'qwen2.5:7b' }] }), { status: 200 })) as unknown as typeof fetch;
    const result = await probeConnection({ ...SETTINGS, model: '' }, mock);
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['qwen2.5:7b']);
  });

  it('列表不可用且没填模型名 → 提示先选模型，而不是「连不上」', async () => {
    const mock = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;
    const result = await probeConnection({ ...SETTINGS, model: '' }, mock);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('not_found');
    expect(result.error).toContain('模型名');
  });
});
