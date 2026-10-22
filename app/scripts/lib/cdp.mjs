/**
 * CDP 客户端复用层（v0.9 / T03 从 `bench-perf.mjs` 抽出）。
 *
 * 为什么抽出来：`bench-perf.mjs`（D6 性能基准）和 `smoke-print.mjs`（打印门禁）
 * 需要的是同一件东西 —— 一个**不带自动化库依赖**（不装 puppeteer / playwright）
 * 的 headless Edge 会话：起进程、读 stderr 里的 ws 地址、开页面 target、
 * `send(method, params)` / `eval(expression)`。
 *
 * 不引 puppeteer 的理由不是「省 20 MB 依赖」这么简单：本项目的产物是
 * 单个 `file://dist/index.html`，puppeteer 的默认启动参数会关掉
 * `--allow-file-access-from-files`，还得再关一堆策略；直连 CDP 反而更短、更可控。
 *
 * ★ 本文件只放**与业务无关**的 CDP 逻辑。
 *   打印断言（媒体查询、分页、PDF 字节）留在 `smoke-print.mjs`，
 *   基准指标留在 `bench-perf.mjs` —— 共用管道，不共用结论。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/** 常见的 Edge 安装位置（Windows 优先；其它平台靠 `JOB_DESK_EDGE` 覆盖） */
export const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge',
];

/**
 * 找一个可用的 Edge 可执行文件。
 *
 * 环境变量 `JOB_DESK_EDGE` 优先（CI 上 Edge 常在非标准路径），
 * 找不到就返回 `null` —— 调用方决定是「报错退出」还是「跳过门禁」。
 *
 * @returns {string | null}
 */
export function findEdge() {
  const override = (process.env.JOB_DESK_EDGE || '').trim();
  if (override && existsSync(override)) return override;
  return EDGE_CANDIDATES.find((path) => existsSync(path)) ?? null;
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * 极简 CDP 客户端：一个 ws + 一张 id → Promise 的表 + 一张事件表。
 *
 * 事件用 `on(method, handler)` 订阅（需要先 `send('Xxx.enable')`）。
 * 只有真的需要「事件流」的消费者才订阅（例如 `Network.requestWillBeSent`
 * 用来证明零外部请求）；其余仍走 `Runtime.evaluate` 轮询 —— 轮询的断言
 * 更容易写，也不会因为事件顺序在 headless 下抖动而偶发失败。
 */
export class Cdp {
  /** @param {WebSocket} ws */
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    /** @type {Map<number, {resolve: (v: any) => void, reject: (e: Error) => void}>} */
    this.pending = new Map();
    /** @type {Map<string, Set<(params: any) => void>>} */
    this.handlers = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : '{}');
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else res(msg.result);
        return;
      }
      if (msg.method && this.handlers.has(msg.method)) {
        for (const handler of this.handlers.get(msg.method)) {
          handler(msg.params ?? {});
        }
      }
    });
  }

  /**
   * 订阅一个 CDP 事件，返回退订函数。
   * @param {string} method
   * @param {(params: any) => void} handler
   * @returns {() => void}
   */
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(handler);
    return () => {
      this.handlers.get(method)?.delete(handler);
    };
  }

  /**
   * 发一条命令并等响应。
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {number} [timeoutMs]
   */
  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((res, reject) => {
      this.pending.set(id, { resolve: res, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, timeoutMs);
    });
  }

  /**
   * 在页面里求值（值按 JSON 回传，Promise 会被 await）。
   * 页面内抛错 → 抛出带原始描述的 Error，而不是静默返回 undefined。
   * @param {string} expression
   */
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || '页面内脚本抛错');
    }
    return result.result.value;
  }
}

/**
 * 轮询求值直到真值（或超时抛错）。
 *
 * 为什么不用固定 `sleep`：真机上「React 渲染完」和「文件解析完」没有确定时间，
 * 固定 sleep 要么慢要么偶发失败。轮询到条件成立即可，超时才是失败。
 *
 * @param {Cdp} page
 * @param {string} expression 返回布尔值的表达式
 * @param {{ timeoutMs?: number, intervalMs?: number, label?: string }} [options]
 */
export async function waitFor(page, expression, options = {}) {
  const { timeoutMs = 30000, intervalMs = 100, label = expression } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try {
      value = await page.eval(expression);
    } catch (error) {
      // 求值本身失败（导航中、上下文销毁）不视为「条件不成立」，
      // 但也不该立刻崩 —— 继续等到超时，好让报错信息是「等什么超时了」。
      if (Date.now() > deadline) throw error;
      value = false;
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）：${label}`);
    await sleep(intervalMs);
  }
}

/**
 * 起一个干净的 headless Edge，开一个空白页面 target。
 *
 * @param {{ edge: string, profileDir: string, extraArgs?: string[], startupTimeoutMs?: number }} options
 * @returns {Promise<{ proc: import('node:child_process').ChildProcess, browser: Cdp, page: Cdp, browserWs: WebSocket, pageWs: WebSocket, port: string, close: () => void }>}
 */
export async function openPage({ edge, profileDir, extraArgs = [], startupTimeoutMs = 20000 }) {
  const proc = spawn(
    edge,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      // 端口 0 = 让浏览器自己挑，从 stderr 的 "DevTools listening on" 里读回来。
      // 固定端口会在并行跑（或上次没退干净）时撞车。
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      // 产物是 file:// 的单文件 HTML：不开这个，页面里 localStorage 与
      // 同源读取会被当作跨源隔离处理
      '--allow-file-access-from-files',
      ...extraArgs,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const wsUrl = await new Promise((res, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Edge 启动超时')), startupTimeoutMs);
    proc.stderr?.on('data', (chunk) => {
      buffer += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        res(match[1]);
      }
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Edge 提前退出，code=${code}`));
    });
  });

  // 浏览器级 ws → 开一个页面 → 拿页面级 ws。
  // （浏览器级的 Target.createTarget 是唯一稳定的开页面方式；
  //  直接用 /json/new 需要 PUT 且不同版本行为不一致。）
  const port = new URL(wsUrl).port;
  const versionRes = await fetch(`http://127.0.0.1:${port}/json/version`);
  const version = await versionRes.json();
  const browserWs = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res) => browserWs.addEventListener('open', res, { once: true }));

  const browser = new Cdp(browserWs);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((item) => item.id === targetId);
  if (!target) throw new Error('开页面失败：target 不在 /json/list 里');
  const pageWs = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res) => pageWs.addEventListener('open', res, { once: true }));

  const close = () => {
    try {
      pageWs.close();
    } catch {
      /* 已关闭 */
    }
    try {
      browserWs.close();
    } catch {
      /* 已关闭 */
    }
    try {
      proc.kill();
    } catch {
      /* 已退出 */
    }
  };

  return { proc, browser, page: new Cdp(pageWs), browserWs, pageWs, port, close };
}
