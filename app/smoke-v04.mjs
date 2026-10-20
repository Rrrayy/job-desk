// v0.4 冒烟：日历记一件事 / 导入课表 / 回到初始状态（Edge headless + CDP，零依赖）
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FILE = 'file:///' + resolve('dist/index.html').replace(/\\/g, '/');
const OUT = resolve('smoke-v04');
const PORT = 9455;
const PROFILE = join(OUT, '.profile-' + Date.now());

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const child = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--disable-extensions', '--allow-file-access-from-files', 'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch { /* retry */ }
  await sleep(300);
}
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

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
const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}
const results = [];
const check = (name, pass, detail = '') => {
  results.push(`${pass ? '✓' : '✗'} ${name}${detail ? ' —— ' + detail : ''}`);
  if (!pass) process.exitCode = 1;
};

await send('Page.enable');
await send('Page.navigate', { url: FILE });
for (let i = 0; i < 50; i++) {
  await sleep(300);
  const ready = await evaluate('document.readyState').catch(() => 'loading');
  if (ready === 'complete') break;
}
await sleep(1200);

// 1) 初始态：应该看到欢迎页
const hasWelcome = await evaluate(`!!document.querySelector('.welcome, [class*="welcome"]')`);
check('初始态显示欢迎页', hasWelcome);

// 2) 加载示例数据（欢迎页按钮）
await evaluate(`(() => {
  const btns = [...document.querySelectorAll('button')];
  const b = btns.find(b => /加载示例/.test(b.textContent));
  if (b) b.click();
  return b ? 'clicked' : 'NO_BUTTON';
})()`);
await sleep(800);
const appCount = await evaluate(`JSON.parse(localStorage.getItem('jobdesk.v1')).applications.length`);
check('示例数据已加载（8 条投递）', appCount === 8, `got ${appCount}`);

// 3) 切到日历视图（按 4）
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '4', code: 'Digit4', windowsVirtualKeyCode: 52 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '4', code: 'Digit4', windowsVirtualKeyCode: 52 });
await sleep(600);
const calText = await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('button')].map(b => b.textContent.trim());
  return {
    hasImport: buttons.some(t => t === '导入课表'),
    hasQuick: buttons.some(t => t.includes('记一件事')),
    title: document.querySelector('.page__title')?.textContent || '',
    conflictShown: /时间冲突/.test(document.body.textContent),
  };
})()`);
check('日历有「导入课表」按钮', calText.hasImport);
check('日历有「记一件事」按钮', calText.hasQuick);
check('示例冲突已呈现（组会 vs 二面）', calText.conflictShown);

// 4) 记一件事：填表提交（React 受控输入必须走原生 value setter）
await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('记一件事')).click()`);
await sleep(300);
await evaluate(`(() => {
  const inputs = [...document.querySelectorAll('.cal__import input')];
  const title = inputs.find(i => i.placeholder && i.placeholder.includes('什么事'));
  if (!title) return 'NO_TITLE_INPUT';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(title, '下午取快递（急事）');
  title.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`);
await sleep(200);
await evaluate(`[...document.querySelectorAll('.cal__import button')].find(b => b.textContent.trim() === '记下').click()`);
await sleep(500);
const afterQuickAdd = await evaluate(`(() => {
  const db = JSON.parse(localStorage.getItem('jobdesk.v1'));
  const ev = db.events[db.events.length - 1];
  return { total: db.events.length, last: ev ? ev.title + '|' + ev.kind + '|' + ev.date : 'NONE' };
})()`);
check('记一件事落库', afterQuickAdd.total === 2 && afterQuickAdd.last.includes('取快递'), JSON.stringify(afterQuickAdd));

// 5) 导入课表：粘贴文本 → 识别 → 确认
await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '导入课表').click()`);
await sleep(300);
await evaluate(`(() => {
  const ta = document.querySelector('.cal__import textarea');
  if (!ta) return 'NO_TA';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '周一 08:00-09:40 高等数学\\n星期四 14:00~15:40 操作系统\\n这行是乱的');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`);
await sleep(300);
const preview = await evaluate(
  `[...document.querySelectorAll('.cal__import .field__hint')].map(p => p.textContent).find(t => t.includes('识别出')) || ''`,
);
check('导入预览显示识别 2 节课', preview.includes('2'), preview.trim());
await evaluate(`[...document.querySelectorAll('.cal__import button')].find(b => b.textContent.includes('导入 '))?.click()`);
await sleep(500);
const afterImport = await evaluate(`(() => {
  const db = JSON.parse(localStorage.getItem('jobdesk.v1'));
  return {
    total: db.events.length,
    courses: db.events.filter(e => e.kind === 'course' && e.weekly).map(e => e.title),
    personal: db.events.filter(e => e.kind !== 'course').length,
  };
})()`);
check('导入替换课表：2 节课入库', afterImport.courses.length === 2, JSON.stringify(afterImport.courses));
check('手动记的事不被导入影响（组会 + 取快递）', afterImport.personal === 2, `personal=${afterImport.personal}`);

// 6) 回到初始状态：设置 → 回到初始状态 → 确认 → 欢迎页重现 + localStorage 清空
await evaluate(`(() => {
  const btns = [...document.querySelectorAll('button')];
  btns.find(b => b.getAttribute('title') === '设置' || /设置/.test(b.getAttribute('title') || ''))?.click();
  return 'ok';
})()`);
await sleep(500);
await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '回到初始状态')?.click()`);
await sleep(300);
await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '确认回到初始状态')?.click()`);
await sleep(600);
const afterReset = await evaluate(`(() => {
  const db = JSON.parse(localStorage.getItem('jobdesk.v1') || 'null');
  return { apps: db?.applications?.length ?? -1, events: db?.events?.length ?? -1, welcome: !!document.querySelector('.welcome, [class*="welcome"]') };
})()`);
check('回到初始状态：数据全空', afterReset.apps === 0 && afterReset.events === 0, JSON.stringify(afterReset));
check('回到初始状态：欢迎页重现', afterReset.welcome === true);

// 截图留证
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(join(OUT, 'final-state.png'), Buffer.from(shot.data, 'base64'));

console.log(results.join('\n'));
console.log(results.every((r) => r.startsWith('✓')) ? '\nALL PASS' : '\nSOME FAILED');
ws.close();
child.kill();
await sleep(400);
