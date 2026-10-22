/**
 * D16 smoke：插件沙箱零网络（v0.8 / T04）。
 *
 * 裸 CDP（Chrome DevTools Protocol），零新依赖（Node ≥22 自带 WebSocket）：
 * 1. 起无头 Chromium（优先 Chrome，回退 Edge）；
 * 2. 加载**构建产物** dist/index.html（测的是出厂代码，不是源码）；
 * 3. 走真实 UI：打开设置 → 插件面板 → DOM.setFileInputFiles 注入示例插件包；
 * 4. 授权 + 启用 → 宿主挂载沙箱 iframe → 在插件执行上下文里断言：
 *    - opaque origin（sandbox 无 allow-same-origin）；
 *    - fetch 直连被 CSP 拦截（connect-src 'none'）；
 *    - Network 域全程零 http(s) 请求（不是「失败了几次」，是根本没发出去）。
 *
 * 用法：`npm run build && node scripts/smoke-plugin.mjs`
 * 退出码 0 = 通过；任何一步失败打印原因并 exit 1。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const distIndex = join(appRoot, 'dist', 'index.html');
const pluginPath = join(appRoot, 'plugins', 'notes-ai.plugin.html');

for (const required of [distIndex, pluginPath]) {
  if (!existsSync(required)) {
    console.error(`✗ 缺少 ${required} —— 先 npm run build`);
    process.exit(1);
  }
}

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const browser = BROWSERS.find((candidate) => existsSync(candidate));
if (!browser) {
  console.error('✗ 没找到 Chrome/Edge，可用 CHROME_PATH 环境变量指定');
  process.exit(1);
}

const userDir = mkdtempSync(join(tmpdir(), 'jd-smoke-'));
const proc = spawn(
  browser,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从 stderr 抓 DevTools listening 行拿浏览器级 WS 地址 */
function devtoolsUrl(timeoutMs = 15000) {
  return new Promise((res, rej) => {
    const started = Date.now();
    proc.stderr.on('data', (chunk) => {
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(String(chunk));
      if (match) res(match[1]);
    });
    const timer = setInterval(() => {
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        rej(new Error('等 DevTools 端口超时'));
      }
    }, 100);
    proc.on('exit', () => {
      clearInterval(timer);
      rej(new Error('浏览器提前退出'));
    });
  });
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
    this.contexts = new Map(); // executionContextId -> { origin, url, sessionId }
    /*
     * sandbox="allow-scripts" 不带 allow-same-origin → opaque origin → 浏览器把 iframe
     * 放进独立进程（OOPIF）。它的执行上下文只在子 target 的会话里出现，
     * 主 target 的 Runtime.executionContextCreated 永远收不到 —— 所以必须 setAutoAttach(flatten)。
     */
    this.sessions = new Map(); // sessionId -> { targetId, type }
  }

  connect() {
    return new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'));
      this.ws.onmessage = (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res2, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(`${msg.error.message}`));
          else res2(msg.result);
          return;
        }
        if (msg.method === 'Target.attachedToTarget') {
          const { sessionId, targetInfo } = msg.params;
          this.sessions.set(sessionId, { targetId: targetInfo.targetId, type: targetInfo.type });
          // 子 target 要自己开 Runtime 才有上下文事件
          this.send('Runtime.enable', {}, sessionId).catch(() => {});
          return;
        }
        if (msg.method === 'Runtime.executionContextCreated') {
          const ctx = msg.params.context;
          this.contexts.set(ctx.id, { origin: ctx.origin, url: ctx.url, sessionId: msg.sessionId ?? null });
        }
      };
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const frame = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(frame));
    });
  }

  /** 在子 target（OOPIF）会话里执行，等 Promise */
  async evaluateInSession(sessionId, expression) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (result.exceptionDetails) {
      throw new Error(`插件上下文执行失败：${result.exceptionDetails.exception?.description ?? '未知异常'}`);
    }
    return result.result.value;
  }

  /** 主上下文执行（awaitPromise：自动等 Promise） */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`页面内执行失败：${result.exceptionDetails.exception?.description ?? '未知异常'}`);
    }
    return result.result.value;
  }
}

async function main() {
  const wsBrowser = await devtoolsUrl();
  const res = await fetch(`http://${new URL(wsBrowser).host}/json/new?about:blank`, { method: 'PUT' });
  if (!res.ok) throw new Error(`建 tab 失败：HTTP ${res.status}`);
  const target = await res.json();
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('DOM.enable');
  // 关键：自动附加子 target（opaque origin 的 iframe 是独立进程）
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  /** 全程收集 http(s) 请求（Network 域）：最终必须为 0 */
  const netRequests = [];
  cdp.ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.method === 'Network.requestWillBeSent' && /^https?:/i.test(msg.params.request.url)) {
      netRequests.push(msg.params.request.url);
    }
  });

  const results = [];
  const step = (name, ok, detail = '') => {
    results.push({ ok });
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` —— ${detail}` : ''}`);
  };

  try {
    /* ---- 1. 加载 dist/index.html ---- */
    await cdp.send('Page.navigate', { url: pathToFileURL(distIndex).href });
    await sleep(1500);
    step('加载 dist/index.html', (await cdp.evaluate('!!document.querySelector(".app")')) === true);

    /* ---- 2. 打开设置抽屉，确认插件面板在 ---- */
    await cdp.evaluate(`document.querySelector('[aria-label="打开设置"]')?.click()`);
    await sleep(500);
    step(
      '设置抽屉里插件面板就位',
      (await cdp.evaluate('!!document.querySelector("[data-testid=plugins-panel]")')) === true,
    );

    /* ---- 3. 注入示例插件包（真实文件输入路径） ---- */
    const doc = await cdp.send('DOM.getDocument');
    const input = await cdp.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: '[data-testid="plugin-file-input"]',
    });
    if (!input.nodeId) throw new Error('没找到插件文件输入框');
    await cdp.send('DOM.setFileInputFiles', { files: [pluginPath], nodeId: input.nodeId });
    await sleep(500);
    const loaded = await cdp.evaluate(
      `(document.querySelector('[data-testid^="plugin-plugin:"]')?.textContent ?? '').slice(0, 60)`,
    );
    step('插件包加载 + manifest 解析', loaded.length > 0, loaded);

    /* ---- 4. 逐项授权 + 启用 → 宿主挂载沙箱 iframe ---- */
    await cdp.evaluate(`document.querySelectorAll('[data-testid^="plugin-perm-"]').forEach((b) => b.click())`);
    await sleep(150);
    await cdp.evaluate(`document.querySelector('[data-testid^="plugin-enable-"]')?.click()`);
    await sleep(900);
    const diag = await cdp.evaluate(
      `JSON.stringify({
        enabledChecked: document.querySelector('[data-testid^="plugin-enable-"]')?.checked ?? null,
        permChecked: [...document.querySelectorAll('[data-testid^="plugin-perm-"]')].map((b) => b.checked),
        iframeCount: document.querySelectorAll('iframe').length,
        panelHtmlLen: (document.querySelector('[data-testid="plugins-panel"]')?.innerHTML ?? '').length,
      })`,
    );
    console.log(`  [diag] ${diag}`);
    step(
      '沙箱 iframe 挂载（sandbox="allow-scripts"）',
      (await cdp.evaluate(`!!document.querySelector('iframe[sandbox="allow-scripts"][data-testid^="plugin-frame-"]')`)) === true,
    );

    /* ---- 5. 插件执行上下文：opaque origin + CSP 拦截 ---- */
    await sleep(800); // 给插件内自检 fetch 的时间
    let pluginSession = null;
    for (const ctx of cdp.contexts.values()) {
      if (ctx.sessionId && (ctx.origin === 'null' || (ctx.url ?? '').includes('notes-ai'))) {
        pluginSession = ctx.sessionId;
        break;
      }
    }
    // 兜底：按 target 类型找（iframe target 就是插件沙箱）
    if (pluginSession === null) {
      for (const [sessionId, info] of cdp.sessions) {
        if (info.type === 'iframe') { pluginSession = sessionId; break; }
      }
    }
    if (pluginSession === null) throw new Error('没找到插件 iframe 的执行上下文（OOPIF 未附加）');
    const raw = await cdp.evaluateInSession(
      pluginSession,
      'JSON.stringify({ origin: window.__ORIGIN, net: window.__NET })',
    );
    const state = JSON.parse(raw);
    step('opaque origin（无 allow-same-origin）', state.origin === 'null', `origin=${state.origin}`);
    step(
      'iframe 内 fetch 被 CSP 拦截',
      typeof state.net === 'string' && state.net.startsWith('BLOCKED'),
      state.net ?? 'undefined',
    );

    /* ---- 6. 全程零 http(s) 网络请求 ---- */
    step('全程零 http(s) 请求（Network 域）', netRequests.length === 0, netRequests.join(', ').slice(0, 120));
  } finally {
    try {
      cdp.ws.close();
    } catch {
      // 已经断了就算了
    }
    proc.kill();
    await sleep(200);
    rmSync(userDir, { recursive: true, force: true });
  }

  if (results.some((r) => !r.ok)) {
    console.error('\n✗ D16 smoke 失败：有步骤未过。');
    process.exit(1);
  }
  console.log('\n✓ D16 smoke 全过：插件 iframe 沙箱零网络，宿主加载路径正常。');
}

main().catch((error) => {
  console.error(`✗ smoke 异常：${error.message}`);
  proc.kill();
  rmSync(userDir, { recursive: true, force: true });
  process.exit(1);
});
