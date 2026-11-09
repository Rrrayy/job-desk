/**
 * AI 客户端网关（v0.8 / T03；v0.10 全面增强）—— **全应用唯一的 `fetch(` 出现点**。
 *
 * 为什么收口到一个文件（ARCH A-02）：「打开页面零请求」是本产品的核心承诺，
 * AI 能力是唯一合法的例外，例外必须小到一眼能审完。`check-no-network.mjs`
 * 对这个文件做「结构性单点放行」：fetch 一条规则豁免、其余 9 条照扫，
 * 白名单文件保持为空。任何其他文件出现 `fetch(` 都会让 CI 直接失败 ——
 * **包括连通性探针**，所以 `probeConnection` 也住在这个文件里，不另开模块。
 *
 * v0.10 增加的六件事（每件都有测试钉着）：
 * 1. **参数注入**：temperature / top_p / max_tokens，缺省即不发（不猜 0.7）
 * 2. **JSON 模式**：response_format，服务端 400 时本次调用自动降级重试
 * 3. **流式用量**：stream_options.include_usage，同一套降级逻辑
 * 4. **推理模型**：SSE/JSON 两条路都认 `reasoning_content`；只有思考没有正文时给明确的错
 * 5. **错误细分**：auth / not_found / rate_limit / cancel 各自有中文人话与建议动作
 * 6. **限流退避**：429 读 Retry-After（≤10s），没有则用退避序列（带确定性抖动）
 *
 * 不变的四条纪律：
 * - body 恒为 `{model, messages, stream}` + 显式参数；不多塞一个字段
 * - 双超时：连接 10s / 总 `timeoutSec`（默认 60s），同一 AbortController 上两个 timer
 * - 重试只对 network / 5xx / 429；4xx（除 429）/ 超时 / 取消 / parse 一律不重试
 * - 无全局状态：`_fetchImpl` 只给测试注入 mock，生产不传
 */

import type {
  AISettings,
  ChatMessage,
  CompletionOptions,
  GatewayErrorCode,
  GenerationParams,
  ProbeResult,
  TokenUsage,
} from './types';

export class GatewayError extends Error {
  code: GatewayErrorCode;
  status?: number;
  /** 429 时服务端要求的等待毫秒数（来自 Retry-After / x-ratelimit-reset-ms） */
  retryAfterMs?: number;

  constructor(code: GatewayErrorCode, message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export const CONNECT_TIMEOUT_MS = 10_000;
/** 总超时缺省值；实际值取 settings.timeoutSec（5–300 秒） */
export const TOTAL_TIMEOUT_MS = 60_000;
/** 重试退避序列（毫秒），长度即最大重试次数 */
export const RETRY_DELAYS_MS = [1_000, 2_000] as const;
/** 429 的 Retry-After 上限：等太久不如直接告诉用户「稍后再试」 */
const MAX_RETRY_AFTER_MS = 10_000;
/** 探针超时：自检不该让用户盯着一个转圈等 60 秒 */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * 错误码 → 一句可执行的中文。
 * 放在网关而不是 UI：同一句话在设置页、面板、探针结果里都要出现，
 * 散着写迟早出现三种说法。
 */
export const ERROR_HINT: Record<GatewayErrorCode, string> = {
  auth: '密钥无效或没有权限 —— 检查 API Key 是否正确',
  not_found: '接口路径或模型不存在 —— 检查地址是否要带 /v1、模型名是否拼对',
  rate_limit: '服务端限流 —— 稍等一会儿再试',
  timeout: '请求超时 —— 可在设置里调大超时时间，或换更快的模型',
  network: '连接失败 —— 检查网络、服务地址，以及本地服务是否已启动',
  parse: '服务返回的内容无法解析 —— 可能是模型不支持 JSON 输出',
  http: '服务端返回错误',
  cancel: '请求已取消',
};

export interface ChatResult {
  text: string;
  finishReason?: string;
  /** 推理模型的思考过程。**不并入 text**：它不是答案，只是排障信息 */
  reasoning?: string;
  /** 服务端返回的用量；没返回就没有这个字段 */
  usage?: TokenUsage;
}

/** OpenAI 兼容端点拼接：容忍 baseURL 带不带尾斜杠 */
export function endpointOf(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/chat/completions`;
}

/** models 端点（探活用） */
export function modelsEndpointOf(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/models`;
}

/** 超时解析：settings.timeoutSec → 毫秒；非法值回落 60s */
export function timeoutOf(settings: AISettings): number {
  const seconds = settings.timeoutSec;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 5 && seconds <= 300) {
    return Math.trunc(seconds) * 1000;
  }
  return TOTAL_TIMEOUT_MS;
}

/** 参数合并：全局（settings）→ 场景覆盖（opts.params），后者的非 undefined 值胜出 */
export function resolveParams(settings: AISettings, opts: CompletionOptions): GenerationParams {
  const override = opts.params ?? {};
  const out: GenerationParams = {};
  const temperature = override.temperature ?? settings.temperature;
  if (typeof temperature === 'number') out.temperature = temperature;
  const topP = override.topP ?? settings.topP;
  if (typeof topP === 'number') out.topP = topP;
  const maxTokens = override.maxTokens ?? settings.maxTokens;
  if (typeof maxTokens === 'number') out.maxTokens = maxTokens;
  if (typeof override.jsonMode === 'boolean') out.jsonMode = override.jsonMode;
  return out;
}

/**
 * 有效 JSON 模式：`off` 一票否决；`on` 无条件带；`auto` 由场景决定（params.jsonMode）。
 * ★ auto 不是「猜」，是「结构化场景才带」—— 探针/自由对话不该被 response_format 限制。
 */
export function wantsJsonMode(settings: AISettings, opts: CompletionOptions): boolean {
  if (settings.jsonMode === 'off') return false;
  if (settings.jsonMode === 'on') return true;
  return opts.params?.jsonMode === true;
}

/** 状态码 → 错误码（401/403 是权限，404 是路径/模型，429 是限流，其余归 http） */
export function classifyStatus(status: number): GatewayErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  return 'http';
}

/** Retry-After 解析：支持秒数与 HTTP 日期；上限 10s */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.min(Math.round(Number(trimmed) * 1000), MAX_RETRY_AFTER_MS);
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS);
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
 * 退避时长。429 优先用服务端给的 Retry-After；
 * 否则用 `RETRY_DELAYS_MS[attempt]` 加**确定性抖动**（+0% / +15% / +30%）。
 * 为什么是确定性而不是随机：随机抖动会让「重试在 3 秒内完成」这类断言变成概率游戏；
 * 确定性抖动同样能把并发客户端的重试时刻错开，只是错开量固定。
 */
function backoffOf(error: GatewayError, attempt: number): number {
  if (error.retryAfterMs !== undefined) return error.retryAfterMs;
  const base = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
  return Math.round(base * (1 + 0.15 * (attempt % 3)));
}

/** 请求体（唯一构造点，测试据此断言「没配置就不出现这个键」） */
export function buildRequestBody(
  settings: AISettings,
  opts: CompletionOptions,
  variant: { includeUsage: boolean; jsonMode: boolean },
): string {
  const params = resolveParams(settings, opts);
  const stream = opts.stream ?? true;
  const body: Record<string, unknown> = {
    model: settings.model.trim(),
    messages: opts.messages,
    stream,
  };
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.topP !== undefined) body.top_p = params.topP;
  if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;
  if (variant.jsonMode) body.response_format = { type: 'json_object' };
  // 只有流式才谈得上 stream_options；非流式的 usage 本来就在响应体里
  if (stream && variant.includeUsage) body.stream_options = { include_usage: true };
  return JSON.stringify(body);
}

/**
 * chat/completions 调用（含 SSE 解析、能力降级与重试）。
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
  const timeoutMs = timeoutOf(settings);

  /**
   * 两个能力标志在**本次调用内**可降级（服务端不认这两个字段是常见情况，
   * 不该让用户去改配置）。降级不消耗重试次数，且单向 —— 所以循环必然收敛。
   */
  let includeUsage = stream;
  let jsonMode = wantsJsonMode(settings, opts);

  let lastError: GatewayError = new GatewayError('network', '未发送');
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    const body = buildRequestBody(settings, opts, { includeUsage, jsonMode });
    try {
      return await attemptOnce(doFetch, settings, url, body, stream, opts, timeoutMs);
    } catch (error) {
      const ge =
        error instanceof GatewayError ? error : new GatewayError('network', String(error));
      lastError = ge;
      const aborted = opts.signal?.aborted === true;

      // ① 能力降级：400 且我们带了可选字段 → 摘掉重来（不计次、不退避）
      if (!aborted && ge.code === 'http' && ge.status === 400) {
        if (jsonMode) {
          jsonMode = false;
          attempt -= 1; // 降级不算一次失败
          continue;
        }
        if (includeUsage) {
          includeUsage = false;
          attempt -= 1;
          continue;
        }
      }

      // ② 重试：取消永远不重试；4xx（非 429）/ 超时 / parse 也不重试
      const retryable = !aborted && (ge.code === 'network' || ge.code === 'rate_limit' || (ge.code === 'http' && ge.status !== undefined && ge.status >= 500));
      if (!retryable || attempt === RETRY_DELAYS_MS.length) throw ge;
      await sleep(backoffOf(ge, attempt), opts.signal);
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
  timeoutMs: number,
): Promise<ChatResult> {
  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort();
  opts.signal?.addEventListener('abort', onExternalAbort, { once: true });
  // 'connect' = 10s 内没等到响应头；'total' = timeoutMs 内没读完。用户取消时两者都是 null。
  let timedOut: 'connect' | 'total' | null = null;
  const connectTimer = setTimeout(() => {
    timedOut = 'connect';
    controller.abort();
  }, CONNECT_TIMEOUT_MS);
  const totalTimer = setTimeout(() => {
    timedOut = 'total';
    controller.abort();
  }, timeoutMs);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

    let response: Response;
    try {
      response = await doFetch(url, { method: 'POST', headers, body, signal: controller.signal });
    } catch (error) {
      if (opts.signal?.aborted) throw new GatewayError('cancel', ERROR_HINT.cancel);
      if (timedOut) {
        throw new GatewayError('timeout', timedOut === 'connect' ? '连接超时（10 秒）' : `响应超时（${Math.round(timeoutMs / 1000)} 秒）`);
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
      const code = classifyStatus(response.status);
      const retryAfter = code === 'rate_limit'
        ? parseRetryAfter(response.headers.get('retry-after') ?? response.headers.get('x-ratelimit-reset-ms'))
        : undefined;
      throw new GatewayError(
        code,
        `HTTP ${response.status}${detail ? `：${detail}` : ''}`,
        response.status,
        retryAfter,
      );
    }

    if (!stream) return await parseJsonResponse(response);

    if (!response.body) throw new GatewayError('parse', '流式响应没有 body');
    return await parseSseStream(response.body, opts);
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    if (opts.signal?.aborted) throw new GatewayError('cancel', ERROR_HINT.cancel);
    if (timedOut) {
      throw new GatewayError('timeout', timedOut === 'connect' ? '连接超时（10 秒）' : `响应超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    throw new GatewayError('network', error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(totalTimer);
    opts.signal?.removeEventListener('abort', onExternalAbort);
  }
}

/** usage 形状归一：OpenAI 用 *_tokens；个别服务直接给 total_tokens */
function readUsage(value: unknown): TokenUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const prompt = typeof raw.prompt_tokens === 'number' ? raw.prompt_tokens : undefined;
  const completion = typeof raw.completion_tokens === 'number' ? raw.completion_tokens : undefined;
  const total = typeof raw.total_tokens === 'number' ? raw.total_tokens : undefined;
  if (total === undefined && prompt === undefined && completion === undefined) return undefined;
  return {
    prompt: prompt ?? 0,
    completion: completion ?? 0,
    total: total ?? (prompt ?? 0) + (completion ?? 0),
  };
}

/** stream:false 的一次性 JSON 响应（含 reasoning_content 兼容） */
async function parseJsonResponse(response: Response): Promise<ChatResult> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new GatewayError('parse', '响应不是合法 JSON');
  }
  const choice = (parsed as {
    choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: unknown }>;
    usage?: unknown;
  }).choices?.[0];
  const text = choice?.message?.content;
  const reasoning = choice?.message?.reasoning_content;
  const usage = readUsage((parsed as { usage?: unknown }).usage);
  const reasoningText = typeof reasoning === 'string' && reasoning.length > 0 ? reasoning : undefined;
  if (typeof text !== 'string') {
    // 推理模型有时只在 reasoning_content 里说话：这不是「解析失败」，要说得更准
    if (reasoningText) {
      throw new GatewayError('parse', '模型只返回了思考过程，没有正文 —— 试试换个非推理模型，或关掉思考模式');
    }
    throw new GatewayError('parse', '响应缺少 choices[0].message.content');
  }
  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined;
  return {
    text,
    ...(finishReason ? { finishReason } : {}),
    ...(reasoningText ? { reasoning: reasoningText } : {}),
    ...(usage ? { usage } : {}),
  };
}

/**
 * SSE 手工解析：按 \n 切行 → `data: ` 前缀 → JSON → delta.content 累积 → [DONE] 结束。
 * v0.10 同时收 `delta.reasoning_content`（推理模型）与末尾 chunk 的 `usage`。
 */
async function parseSseStream(body: ReadableStream<Uint8Array>, opts: CompletionOptions): Promise<ChatResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let finishReason: string | undefined;
  let usage: TokenUsage | undefined;
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
        choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: unknown }>;
        usage?: unknown;
      };
      try {
        event = JSON.parse(payload);
      } catch {
        throw new GatewayError('parse', 'SSE 数据行不是合法 JSON');
      }
      const delta = event.choices?.[0]?.delta;
      const content = delta?.content;
      if (typeof content === 'string' && content.length > 0) {
        text += content;
        opts.onDelta?.(content);
      }
      const thinking = delta?.reasoning_content;
      if (typeof thinking === 'string' && thinking.length > 0) reasoning += thinking;
      const reason = event.choices?.[0]?.finish_reason;
      if (typeof reason === 'string') finishReason = reason;
      // include_usage 时最后一个 chunk 只有 usage、choices 为空
      const chunkUsage = readUsage(event.usage);
      if (chunkUsage) usage = chunkUsage;
    }
  }

  if (text.length === 0) {
    if (reasoning.length > 0) {
      throw new GatewayError('parse', '模型只返回了思考过程，没有正文 —— 试试换个非推理模型，或关掉思考模式');
    }
    throw new GatewayError('parse', '模型返回了空内容');
  }
  return {
    text,
    ...(finishReason ? { finishReason } : {}),
    ...(reasoning.length > 0 ? { reasoning } : {}),
    ...(usage ? { usage } : {}),
  };
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

/* ============================ 连通性自检（v0.10 / L1-2） ============================ */

/** 带超时的单次探测请求（不参与主链重试：自检要慢，用户会以为卡死） */
async function probeFetch(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await doFetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 连通性自检。**只在用户点「测试连接」时调用。**
 *
 * 顺序：`GET {base}/models`（顺便拿到模型列表）→ 失败则退回一次最小
 * `POST /chat/completions`（max_tokens:1）—— 很多自建网关根本不实现 /models，
 * 不能因为没有模型列表就判定「连不上」。
 *
 * 401/403 不退回 chat：同一个密钥必然同样失败，多打一次只是浪费。
 */
export async function probeConnection(settings: AISettings, _fetchImpl?: typeof fetch): Promise<ProbeResult> {
  const doFetch = _fetchImpl ?? fetch;
  const base = settings.baseURL.trim().replace(/\/+$/, '');
  if (!base) {
    return { ok: false, latencyMs: 0, models: [], error: '尚未填写服务地址', code: 'network' };
  }
  const headers: Record<string, string> = {};
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  const started = Date.now();
  const models: string[] = [];

  // ① 模型列表（同时也是最轻的探活）
  try {
    const response = await probeFetch(doFetch, modelsEndpointOf(base), { method: 'GET', headers });
    if (response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      const data = typeof payload === 'object' && payload !== null && Array.isArray((payload as { data?: unknown }).data)
        ? ((payload as { data: unknown[] }).data)
        : [];
      for (const entry of data) {
        if (typeof entry === 'object' && entry !== null) {
          const id = (entry as { id?: unknown }).id;
          if (typeof id === 'string' && id.trim()) models.push(id.trim());
        }
      }
      return {
        ok: true,
        latencyMs: Date.now() - started,
        models: models.slice(0, 200),
        via: 'models',
      };
    }
    const code = classifyStatus(response.status);
    if (code === 'auth') {
      return { ok: false, latencyMs: Date.now() - started, models: [], code, error: ERROR_HINT.auth };
    }
  } catch {
    // 读不到列表不算失败，交给 chat 探针定论
  }

  // ② 最小 chat 探针：能回一句话就算通
  const model = settings.model.trim();
  if (!model) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      models,
      code: 'not_found',
      error: '服务可达，但还没填模型名 —— 从上方候选里选一个',
    };
  }
  try {
    const response = await probeFetch(doFetch, endpointOf(base), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
        max_tokens: 1,
      }),
    });
    if (response.ok) {
      // 读掉 body，避免连接挂起（值不关心）
      await response.text().catch(() => '');
      return { ok: true, latencyMs: Date.now() - started, models, via: 'chat' };
    }
    const code = classifyStatus(response.status);
    const detail = await response.text().catch(() => '');
    return {
      ok: false,
      latencyMs: Date.now() - started,
      models,
      code,
      error: `${ERROR_HINT[code]}${detail ? `（HTTP ${response.status}）` : ''}`,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    const code: GatewayErrorCode = aborted ? 'timeout' : 'network';
    return {
      ok: false,
      latencyMs: Date.now() - started,
      models,
      code,
      error: aborted ? '探测超时（15 秒）—— 服务没有响应' : ERROR_HINT.network,
    };
  }
}
