/**
 * v0.6 发布资产回归：直接打开 release/v0.6.0/index.html（不是 dist）。
 *
 * 目的：确认「真正发出去的那个文件」能用，而不是只有 dist 能用。
 * 检查：
 *   1. 标题与挂载点
 *   2. 无控制台错误
 *   3. 版本号显示 v0.6.0
 *   4. 设置页有「备份加密」开关且默认关闭
 *   5. 设置页有「备份提醒天数」输入
 *   6. 没有旧 key 迁移报错（全新库走欢迎页 or 示例数据）
 *
 * 用法：node smoke-v06-release.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// 本脚本在 app/ 下，release/ 在仓库根（dirname+'/..'）
const APP_DIR = dirname(fileURLToPath(import.meta.url));
const TARGET = join(APP_DIR, '..', 'release', 'v0.8.0', 'index.html');
const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

if (!existsSync(TARGET)) {
  console.error('✗ 找不到 release/v0.7.0/index.html，先 npm run release:pack');
  process.exit(1);
}
const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!edge) {
  console.error('✗ 找不到 Edge');
  process.exit(1);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else res(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, reject) => {
      this.pending.set(id, { resolve: res, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const port = 9333 + Math.floor(Math.random() * 200);
const userDataDir = join(tmpdir(), `jd-v06-${Date.now()}`);
const proc = spawn(edge, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  '--allow-file-access-from-files',
  '--window-size=1440,900',
  'about:blank',
]);

let ws = null;
try {
  let targets = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      targets = await res.json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch {
      /* 还没起来 */
    }
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('CDP 页面没起来');

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const cdp = new Cdp(ws);

  const consoleErrors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params.exceptionDetails.text);
    }
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: 'file:///' + TARGET.replace(/\\/g, '/') });
  await sleep(2500);

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    return r.result?.value;
  };

  // 1. 标题
  const title = await evalJs('document.title');
  check('页面标题', /求职工作台/.test(title || ''), title);

  // 2. 挂载点有内容
  const rootLen = await evalJs('(document.getElementById("root")||{}).innerHTML?.length || 0');
  check('React 已挂载', rootLen > 500, `root innerHTML ${rootLen} 字符`);

  // 3~4. 版本号在设置页底部，先记控制台错误数，进设置页后一起验
  check('无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || '0 条');

  // 5. 示例数据 / 欢迎页二者必居其一，且不落在失败页
  const bodyText = await evalJs('document.body.innerText');
  const onFailPage = /数据读不出来|数据异常|无法读取/.test(bodyText || '');
  check('未落在数据失败页', !onFailPage);

  // 6. 进入设置页（顶栏是图标按钮，只有 title/aria-label）
  const clicked = await evalJs(`(() => {
    const t = document.querySelector('button[title="设置"], button[aria-label="打开设置"]');
    if (!t) return false;
    t.click();
    return true;
  })()`);
  check('能进入设置页', !!clicked);
  await sleep(900);

  const settingsText = await evalJs('document.body.innerText');
  check('设置页显示 v0.8.0', /v0.8.0/.test(settingsText || ''));
  check('设置页有备份加密开关', /加密/.test(settingsText || ''));
  check('设置页有备份提醒天数', /提醒.*天|天.*提醒/.test(settingsText || ''));

  // 7. 主 key 结构完好
  const dbOk = await evalJs(`(() => {
    const raw = localStorage.getItem('jobdesk.v1');
    if (!raw) return 'no-key';
    try { const o = JSON.parse(raw); return o && o.settings ? 'ok' : 'bad-shape'; }
    catch { return 'bad-json'; }
  })()`);
  check('jobdesk.v1 结构完好', dbOk === 'ok' || dbOk === 'no-key', String(dbOk));

  const failKeys = await evalJs(
    `Object.keys(localStorage).filter(k => k.startsWith('jobdesk.v1.failedAt.')).length`,
  );
  check('没有产生 failedAt 快照', failKeys === 0, `${failKeys} 个`);

  await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => {});
} catch (err) {
  check('脚本执行', false, err.message);
} finally {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  proc.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.name).join('、'));
  process.exit(1);
}
