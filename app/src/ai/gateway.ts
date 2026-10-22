/**
 * AI 客户端网关（v0.8 / T03）—— **全应用唯一的 `fetch(` 出现点**。
 *
 * 为什么收口到一个文件（ARCH A-02）：「打开页面零请求」是本产品的核心承诺，
 * AI 能力是唯一合法的例外，例外必须小到一眼能审完。`check-no-network.mjs`
 * 对这个文件做「结构性单点放行」：fetch 一条规则豁免、其余 10 条照扫，
 * 白名单文件保持为空。任何其他文件出现 `fetch(` 都会让 CI 直接失败。
 *
 * 实现要点（ARCH §1.4）：
 * - URL = baseURL 去尾斜杠 + '/chat/completions'（OpenAI 兼容端点）
 * - 有 apiKey 才带 `Authorization: Bearer`（Ollama 等本地服务不填）
 * - body 恒为 `{model, messages, stream}`；stream 缺省 true
 * - SSE 手工解析：`data: ` 前缀 → JSON → `choices[0].delta.content` → `[DONE]` 结束
 * - 双超时：连接 10s / 总 60s，同一 AbortController 上两个 timer
 * - 重试：仅 http≥5xx 与 network；退避 1s→2s，最多 2 次；4xx/超时/取消/parse 不重试
 * - 整个模块无全局状态：`_fetchImpl` 只给测试注入 mock 用，生产不传
 */

import type { AISettings, ChatMessage, CompletionOptions, GatewayErrorCode } from './types';

export class GatewayError extends Error {
  code: GatewayErrorCode;
  status?: number;

  constructor(code: GatewayErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export const CONNECT_TIMEOUT_MS = 10_000;
export const TOTAL_TIMEOUT_MS = 60_000;
/** 重试退避序列（毫秒），长度即最大重试次数 */
export const RETRY_DELAYS_MS = [1_000, 2_000] as const;

export interface ChatResult {
  text: string;
  finishReason?: string;
}

/** OpenAI 兼容端点拼接：容忍 baseURL 带不带尾斜杠 */
export function endpointOf(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/chat/completions`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = (): void => {
        clearTimeout(timer);
        const error = new Error('请求已取消');
        error.name = 'AbortError';
        reject(error);
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * chat/completions 调用（含 SSE 解析与重试）。
 * `_fetchImpl`：测试注入点。生产代码不传，走全局 fetch —— 全应用仅此一处。
 */
export async function chatCompletions(
  settings: AISettings,
  opts: CompletionOptions,
  _fetchImpl?: typeof fetch,
): Promise<ChatResult> {
  if (!settings.baseURL.trim()) throw new GatewayError('network', 'AI 服务地址未配置');
  if (!settings.model.trim()) throw new GatewayError('network', '模型名未配置');
  const doFetch = _fetchImpl ?? fetch;
  const url = endpointOf(settings.baseURL.trim());
  const stream = opts.stream ?? true;
  const body = JSON.stringify({ model: settings.model.trim(), messages: opts.messages, stream });

  let lastError: GatewayError = new GatewayError('network', '未发送');
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await attemptOnce(doFetch, settings, url, body, stream, opts);
    } catch (error) {
      const ge =
        error instanceof GatewayError ? error : new GatewayError('network', String(error));
      lastError = ge;
      // 取消永远不重试；4xx / 超时 / parse 也不重试（重试只会得到同样的答案或白等）
      const aborted = opts.signal?.aborted === true;
      const retryable =
        !aborted &&
        (ge.code === 'network' || (ge.code === 'http' && ge.status !== undefined && ge.status >= 500));
      if (!retryable || attempt === RETRY_DELAYS_MS.length) throw ge;
      await sleep(RETRY_DELAYS_MS[attempt], opts.signal);
    }
  }
  throw lastError; // 循环必然 return/throw，这里只是让 TS 满意
}

/** 单次尝试：fetch + 双超时 + SSE/JSON 解析 */
async function attemptOnce(
  doFetch: typeof fetch,
  settings: AISettings,
  url: string,
  body: string,
  stream: boolean,
  opts: CompletionOptions,
): Promise<ChatResult> {
  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort();
  opts.signal?.addEventListener('abort', onExternalAbort, { once: true });
  // 'connect' = 10s 内没等到响应头；'total' = 60s 内没读完。用户取消时两者都是 null。
  let timedOut: 'connect' | 'total' | null = null;
  const connectTimer = setTimeout(() => {
    timedOut = 'connect';
    controller.abort();
  }, CONNECT_TIMEOUT_MS);
  const totalTimer = setTimeout(() => {
    timedOut = 'total';
    controller.abort();
  }, TOTAL_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

    let response: Response;
    try {
      response = await doFetch(url, { method: 'POST', headers, body, signal: controller.signal });
    } catch (error) {
      if (opts.signal?.aborted) throw new GatewayError('network', '请求已取消');
      if (timedOut) {
        throw new GatewayError('timeout', timedOut === 'connect' ? '连接超时（10 秒）' : '响应超时（60 秒）');
      }
      throw new GatewayError('network', error instanceof Error ? error.message : String(error));
    }
    // 响应头到了 → 连接阶段结束，交出连接计时器（总计时器继续盯着读流）
    clearTimeout(connectTimer);

    if (!response.ok) {
      // 原文只截 200 字进错误消息供当场排障；RequestLog 永不收原文（PRD 验收 13）
      let detail = '';
      try {
        detail = (await response.text()).slice(0, 200);
      } catch {
        // 读不到 body 就不给 detail，绝不因为排障信息把请求挂死
      }
      throw new GatewayError('http', `HTTP ${response.status}${detail ? `：${detail}` : ''}`, response.status);
    }

    if (!stream) return await parseJsonResponse(response);

    if (!response.body) throw new GatewayError('parse', '流式响应没有 body');
    return await parseSseStream(response.body, opts);
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    if (opts.signal?.aborted) throw new GatewayError('network', '请求已取消');
    if (timedOut) {
      throw new GatewayError('timeout', timedOut === 'connect' ? '连接超时（10 秒）' : '响应超时（60 秒）');
    }
    throw new GatewayError('network', error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(totalTimer);
    opts.signal?.removeEventListener('abort', onExternalAbort);
  }
}

/** stream:false 的一次性 JSON 响应 */
async function parseJsonResponse(response: Response): Promise<ChatResult> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new GatewayError('parse', '响应不是合法 JSON');
  }
  const choice = (parsed as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }> })
    .choices?.[0];
  const text = choice?.message?.content;
  if (typeof text !== 'string') throw new GatewayError('parse', '响应缺少 choices[0].message.content');
  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined;
  return finishReason ? { text, finishReason } : { text };
}

/** SSE 手工解析：按 \n 切行 → `data: ` 前缀 → JSON → delta.content 累积 → [DONE] 结束 */
async function parseSseStream(body: ReadableStream<Uint8Array>, opts: CompletionOptions): Promise<ChatResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let finishReason: string | undefined;
  let done = false;

  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let newlineAt = buffer.indexOf('\n');
    while (newlineAt >= 0) {
      const line = buffer.slice(0, newlineAt).trim();
      buffer = buffer.slice(newlineAt + 1);
      newlineAt = buffer.indexOf('\n');
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        done = true;
        break;
      }
      let event: {
        choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }>;
      };
      try {
        event = JSON.parse(payload);
      } catch {
        throw new GatewayError('parse', 'SSE 数据行不是合法 JSON');
      }
      const delta = event.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        text += delta;
        opts.onDelta?.(delta);
      }
      const reason = event.choices?.[0]?.finish_reason;
      if (typeof reason === 'string') finishReason = reason;
    }
  }
  return finishReason ? { text, finishReason } : { text };
}

/** 便捷封装：单条 user 消息 + system 提示，非流式取全文（内置场景常用） */
export async function completeOnce(
  settings: AISettings,
  system: string,
  user: string,
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const result = await chatCompletions(settings, { messages, stream: false });
  return result.text;
}
