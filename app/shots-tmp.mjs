/**
 * 重拍 README 门面截图（v0.3）：
 * 1440×900、deviceScaleFactor=2（Retina 清晰度），示例数据，五个视图 + 详情抽屉。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const APP = 'file:///F:/%E7%AE%80%E5%8E%86/%E6%B1%82%E8%81%8C%E5%B7%A5%E5%85%B7/job-desk/app/dist/index.html';
const OUT = 'F:/简历/求职工具/job-desk/docs/screenshots-v0.3';
const PORT = 9341;
const profile = mkdtempSync(join(tmpdir(), 'jd-shots-'));

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1440,900', APP,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page;
for (let i = 0; i < 40 && !page; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  } catch {}
  if (!page) await sleep(250);
}
if (!page) throw new Error('CDP 没起来');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 1; const pend = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => { const i = id++; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.result?.exceptionDetails) throw new Error('页面脚本异常');
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await sleep(1200);

mkdirSync(OUT, { recursive: true });

// 加载示例数据
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('加载示例数据看看'))?.click()`);
await sleep(1600);
// 关掉加载完成的 toast（会盖住顶栏，截图里很难看）
await ev(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '×'
    || b.closest('[class*="toast"]') && b.textContent.trim() === '×');
  btn?.click();
  // 兜底：把 toast 容器整个隐藏
  document.querySelectorAll('[class*="toast"]').forEach(el => { el.style.display = 'none'; });
})()`);
await sleep(500);

const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name), Buffer.from(r.result.data, 'base64'));
  console.log('✓', name);
};
const goto = async (label) => {
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='${label}')?.click()`);
  await sleep(900);
};

// 1. 今日（hero）
await shot('01-today.png');

// 2. 看板
await goto('看板');
await shot('02-board.png');

// 3. 列表
await goto('列表');
await shot('03-list.png');

// 4. 详情抽屉（找有截止日的公司：小红书）
await ev(`[...document.querySelectorAll('tr')].find(tr=>tr.textContent.includes('小红书'))?.click()`);
await sleep(1000);
await shot('04-drawer.png');
await ev(`document.querySelector('.drawer-overlay')?.click()`);
await sleep(400);

// 5. 日历
await goto('日历');
await shot('05-calendar.png');

// 6. 复盘（数据 tab）
await goto('复盘');
await sleep(600);
await shot('06-insights.png');

// 7. 窄屏（手机）
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(800);
await goto('今日');
await shot('07-mobile-today.png');

ws.close(); child.kill('SIGKILL');
console.log('完成 →', OUT);
