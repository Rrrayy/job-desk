/**
 * 采集 README 顶部的「动态演示」帧序列。
 *
 * 做法：打开构建好的 dist/index.html（就是用户双击的那个文件），用 CDP 派发
 * 真实的鼠标事件走完一条完整使用路径，同时逐帧截图；页面上注入一枚假光标，
 * 因为 Page.captureScreenshot 不含系统指针，否则观众看不出「谁在点」。
 *
 * 产物：
 *   app/shots-demo/frame-000.png …（1120×680 @2x，透明背景已拍平）
 *   app/shots-demo/manifest.json（每帧停留毫秒数，合成时按它写 duration）
 *
 * 合成（本地一次性，仓库不依赖 Pillow）：
 *   python -m pip install Pillow
 *   python app/scripts/make-demo-gif.py        # 见该脚本，输出 assets/demo.gif
 *
 * 用法：node app/gh-demo-gif.mjs [--headful]
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const HEADFUL = process.argv.includes('--headful');
const OUT = resolve('shots-demo');
const PORT = 9451;
const PROFILE = join(OUT, `.profile-${Date.now()}`);
const VIEWPORT = { width: 1120, height: 680, deviceScaleFactor: 2 };

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const BROWSER = CANDIDATES.find((p) => existsSync(p));
if (!BROWSER) throw new Error('没找到 Edge / Chrome');

mkdirSync(OUT, { recursive: true });

const child = spawn(
  BROWSER,
  [
    ...(HEADFUL ? [] : ['--headless=new']),
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function getWsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('CDP 端口无响应');
}

const ws = new WebSocket(await getWsUrl());
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve: r, reject: j } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? j(new Error(JSON.stringify(msg.error))) : r(msg.result);
  }
};
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expression.slice(0, 120));
  return r.result.value;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, mobile: false });

const INDEX = resolve('dist/index.html');
const URL_ = pathToFileURL(INDEX).href;

async function waitApp() {
  for (let i = 0; i < 80; i++) {
    const ready = await evaluate(
      `Boolean(document.querySelector('.topbar, .welcome, .overlay--welcome'))`,
    );
    if (ready) return;
    await sleep(120);
  }
  throw new Error('应用没渲染出来');
}

async function navigate(url) {
  await send('Page.navigate', { url });
  await sleep(300);
  for (let i = 0; i < 80; i++) {
    try {
      if ((await evaluate('document.readyState')) === 'complete') break;
    } catch {
      /* 导航中 */
    }
    await sleep(100);
  }
}

/* ---------------------------------- 帧 ---------------------------------- */

const frames = [];
async function shot(holdMs, label = '') {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const name = `frame-${String(frames.length).padStart(3, '0')}.png`;
  writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'));
  frames.push({ file: name, duration: holdMs, label });
  console.log(`  ${name}  ${String(holdMs).padStart(4)}ms  ${label}`);
}

/* -------------------------------- 假光标 -------------------------------- */

async function installCursor() {
  await evaluate(`(() => {
    if (document.getElementById('__dc')) return;
    const el = document.createElement('div');
    el.id = '__dc';
    el.style.cssText = [
      'position:fixed', 'left:-200px', 'top:-200px', 'width:24px', 'height:24px',
      'pointer-events:none', 'z-index:2147483647', 'transform-origin:4px 2px',
      'transition:left .34s cubic-bezier(.22,.61,.36,1), top .34s cubic-bezier(.22,.61,.36,1), transform .11s ease-out',
      'will-change:left,top,transform', 'filter:drop-shadow(0 1px 2px rgba(0,0,0,.28))',
    ].join(';');
    el.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24">' +
      '<path d="M4.5 2.5 L4.5 19.6 L9.1 15.3 L12.2 21.6 L15.1 20.2 L12.1 14.1 L18.6 13.7 Z" ' +
      'fill="#15181d" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    el.style.marginLeft = '-4px';
    el.style.marginTop = '-2px';
    document.body.appendChild(el);
  })()`);
}

async function moveTo(x, y, ms = 340) {
  await evaluate(
    `(() => { const c = document.getElementById('__dc');
      c.style.transitionDuration = '${ms}ms, ${ms}ms, .11s';
      c.style.left = '${x}px'; c.style.top = '${y}px'; })()`,
  );
}

async function pressDown() {
  await evaluate(`document.getElementById('__dc').style.transform = 'scale(.82)'`);
}
async function pressUp() {
  await evaluate(`document.getElementById('__dc').style.transform = 'scale(1)'`);
}

async function clickAt(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await sleep(40);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await pressDown();
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await pressUp();
}

/** 取元素中心点；selectors 可以是 CSS 选择器或返回元素的表达式 */
async function locate(css, index = 0) {
  const r = await evaluate(`(() => {
    const els = document.querySelectorAll(${JSON.stringify(css)});
    const el = els[${index}];
    if (!el) return { missing: true, count: els.length };
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2),
             count: els.length, w: Math.round(b.width), h: Math.round(b.height) };
  })()`);
  if (r.missing) throw new Error(`找不到 ${css}[${index}]（同选择器共 ${r.count} 个）`);
  return r;
}

/** 找到「带 ⚠ 角标的日历格」中心点 */
async function locateConflictCell() {
  const r = await evaluate(`(() => {
    const cell = document.querySelector('.cal__cell:has(.cal__warn)');
    if (!cell) return { missing: true };
    cell.scrollIntoView({ block: 'nearest' });
    const b = cell.getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  })()`);
  if (r.missing) throw new Error('日历里没有带 ⚠ 的格子');
  return r;
}

/* --------------------------------- 流程 --------------------------------- */
// 分镜原则（v2）：每个视图停留 ≥1.3s 让观众看清；视图切换的光标移动 550ms；
// 关键细节各给特写：红色待办 → 抽屉 → 催进清零 → 双向冲突 → 全局搜索直达。

console.log(`加载 ${URL_}`);
await navigate(URL_);
await waitApp();

// 每次都从「第一次打开」开始，避免上一轮跑完的 localStorage 让欢迎页不出现
await evaluate('localStorage.clear()');
await navigate(URL_);
await waitApp();
await sleep(350);

await installCursor();
await evaluate(`window.scrollTo(0, 0)`);

/* 1. 欢迎页 → 加载示例数据 */
await moveTo(920, 610, 0);
await shot(950, '欢迎页');

const loadBtn = await locate('.welcome__actions .btn', 0);
await moveTo(loadBtn.x, loadBtn.y, 550);
await shot(170, '光标移向「加载示例数据」');
await sleep(430);
await shot(430, '悬停');
await clickAt(loadBtn.x, loadBtn.y);
await shot(150, '点击');
await sleep(500);
await shot(1500, '今日视图 + 加载提示');

/* 2. 今日：最紧急的红色待办 → 点开详情抽屉 */
const firstAction = await locate('.action-list .action-item', 0);
await moveTo(firstAction.x, firstAction.y, 520);
await shot(170, '光标移向红色待办');
await sleep(430);
await shot(800, '红色待办特写（该催了）');

const actionBtn = await locate('.action-list .action-item .btn--tiny', 0);
await moveTo(actionBtn.x, actionBtn.y, 450);
await shot(150, '光标移向「去催一下」');
await sleep(320);
await clickAt(actionBtn.x, actionBtn.y);
await shot(150, '点击');
await sleep(520);
await shot(1300, '详情抽屉：截止 / 沉默 / 下一步');

/* 3. 抽屉里催一下 → 话术 + toast，顶栏沉默计数清零 */
const followBtn = await locate('.drawer__actions .btn--primary', 0);
await moveTo(followBtn.x, followBtn.y, 480);
await shot(170, '光标移向「去催一下」');
await sleep(360);
await shot(300, '悬停');
await clickAt(followBtn.x, followBtn.y);
await shot(150, '点击');
await sleep(650);
await shot(1600, '话术 + 提示（沉默计时清零）');

/* 4. 关抽屉 → 看板 */
const closeBtn = await locate('.drawer .icon-btn', 0);
await moveTo(closeBtn.x, closeBtn.y, 450);
await shot(150, '光标移向关闭');
await sleep(300);
await clickAt(closeBtn.x, closeBtn.y);
await shot(140, '点击');
await sleep(420);
await shot(600, '回到今日');

const boardTab = await locate('.nav__item', 1);
await moveTo(boardTab.x, boardTab.y, 550);
await shot(170, '光标移向「看板」');
await sleep(420);
await clickAt(boardTab.x, boardTab.y);
await shot(150, '点击');
await sleep(480);
await shot(1500, '看板');

const card1 = await locate('.app-card', 1);
await moveTo(card1.x, card1.y, 480);
await shot(800, '卡片悬停');

/* 5. 日历：整月冲突角标 → 点开冲突那天看双向提示 */
const calTab = await locate('.nav__item', 3);
await moveTo(calTab.x, calTab.y, 520);
await shot(170, '光标移向「日历」');
await sleep(380);
await clickAt(calTab.x, calTab.y);
await shot(150, '点击');
await sleep(460);
await shot(1700, '日历（⚠ 时间冲突计数）');

const conflictCell = await locateConflictCell();
await moveTo(conflictCell.x, conflictCell.y, 500);
await shot(170, '光标移向冲突那天');
await sleep(380);
await clickAt(conflictCell.x, conflictCell.y);
await shot(150, '点击');
await sleep(500);
await shot(1600, '双向冲突：面试 × 组会');

/* 6. 列表 */
const listTab = await locate('.nav__item', 2);
await moveTo(listTab.x, listTab.y, 520);
await shot(170, '光标移向「列表」');
await sleep(380);
await clickAt(listTab.x, listTab.y);
await shot(150, '点击');
await sleep(440);
await shot(1300, '列表：按沉默排序');

/* 7. 全局搜索「小红书」→ 结果直达详情 */
const searchBox = await locate('.search__input', 0);
await moveTo(searchBox.x, searchBox.y, 480);
await shot(170, '光标移向搜索框');
await sleep(330);
await clickAt(searchBox.x, searchBox.y);
await sleep(180);
await send('Input.insertText', { text: '小红书' });
await sleep(420);
await shot(1000, '搜索结果浮层');

const hit = await locate('.search__result', 0);
await moveTo(hit.x, hit.y, 420);
await shot(420, '悬停结果');
await clickAt(hit.x, hit.y);
await shot(150, '点击');
await sleep(520);
await shot(1400, '从搜索直达详情');

/* 收尾：把鼠标挪开，让画面回到干净状态 */
await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await sleep(360);
await moveTo(1020, 640, 520);
await shot(950, '收尾');

writeFileSync(
  join(OUT, 'manifest.json'),
  JSON.stringify({ viewport: VIEWPORT, frames }, null, 2) + '\n',
  'utf8',
);
console.log(`\n共 ${frames.length} 帧，总时长 ${frames.reduce((a, f) => a + f.duration, 0)}ms`);
console.log(`输出目录 ${OUT}`);

ws.close();
child.kill();
await sleep(200);
process.exit(0);
