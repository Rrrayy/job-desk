// v0.4.1 冒烟：重复投递提醒 / 撤销与重做 / 版本与备份展示（Edge headless + CDP，零依赖）
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FILE = 'file:///' + resolve('dist/index.html').replace(/\\/g, '/');
const OUT = resolve('smoke-v041');
const PORT = 9457;
const PROFILE = join(OUT, '.profile-' + Date.now());

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
    if (msg.error) j(new Error(JSON.stringify(msg.error)));
    else r(msg.result);
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
const db = () => evaluate(`JSON.parse(localStorage.getItem('jobdesk.v1') || '{}')`);
/** React 受控输入必须走原生 setter，直接赋值不触发 onChange */
const SET_INPUT = `(el, value) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}`;

await send('Page.enable');
await send('Page.navigate', { url: FILE });
for (let i = 0; i < 50; i++) {
  await sleep(300);
  const ready = await evaluate('document.readyState').catch(() => 'loading');
  if (ready === 'complete') break;
}
await sleep(1200);

// 关掉欢迎页：直接开始记第一家
await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('自己记'));
  if (btn) btn.click();
  return 'ok';
})()`);
await sleep(400);

// 1) 记一家「冒烟公司 / 前端实习生」
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true })); 'ok'`);
await sleep(400);
await evaluate(`(() => {
  const set = ${SET_INPUT};
  const inputs = [...document.querySelectorAll('.modal input')];
  set(inputs[0], '冒烟公司');
  set(inputs[1], '前端实习生');
  return 'ok';
})()`);
await sleep(200);
await evaluate(`[...document.querySelectorAll('.modal button')].find(b => b.textContent.includes('保存并继续')).click()`);
await sleep(500);
let snapshot = await db();
check('记一家落库', snapshot.applications?.length === 1, `applications=${snapshot.applications?.length}`);

// 2) 同公司同岗位再记一次 → 必须先出现重复提醒，且按钮变成「仍然保存」
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true })); 'ok'`);
await sleep(400);
await evaluate(`(() => {
  const set = ${SET_INPUT};
  const inputs = [...document.querySelectorAll('.modal input')];
  set(inputs[0], '冒烟公司');
  set(inputs[1], '前端实习生');
  return 'ok';
})()`);
await sleep(300);
const dupUi = await evaluate(`(() => ({
  warn: !!document.querySelector('.qa-dup'),
  warnText: document.querySelector('.qa-dup')?.textContent || '',
  saveLabel: [...document.querySelectorAll('.modal button')].find(b => b.textContent.includes('保存'))?.textContent?.trim(),
}))()`);
check('重复提醒出现', dupUi.warn === true, dupUi.warnText.slice(0, 40));
check('按钮变为「仍然保存」', (dupUi.saveLabel || '').includes('仍然保存'), dupUi.saveLabel);

// 第一次点击：只提醒，不写入
await evaluate(`[...document.querySelectorAll('.modal button')].find(b => b.textContent.includes('仍然保存')).click()`);
await sleep(300);
snapshot = await db();
check('第一次点击不写入', snapshot.applications?.length === 1, `applications=${snapshot.applications?.length}`);
check('二次确认态出现', await evaluate(`!!document.querySelector('.qa-dup.is-confirmed')`));

// 第二次点击：真正写入
await evaluate(`[...document.querySelectorAll('.modal button')].find(b => /仍然保存|保存并继续/.test(b.textContent)).click()`);
await sleep(500);
snapshot = await db();
check('二次确认后写入', snapshot.applications?.length === 2, `applications=${snapshot.applications?.length}`);
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 'ok'`);
await sleep(300);

// 3) 改状态 → Ctrl+Z 撤销 → Ctrl+Shift+Z 重做
//    先切到列表视图（今日视图里刚记的投递还没到提醒阈值，不会出现行）
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true })); 'ok'`);
await sleep(500);
const rowOpened = await evaluate(`(() => {
  const row = document.querySelector('tbody tr') || document.querySelector('.app-row');
  if (!row) return 'NO_ROW';
  row.click();
  return 'ok';
})()`);
await sleep(500);
check('能从列表打开详情', rowOpened === 'ok', String(rowOpened));

const selectChanged = await evaluate(`(() => {
  const selects = [...document.querySelectorAll('.drawer select')];
  const target = selects.find(s => [...s.options].some(o => o.value === 'chatting'));
  if (!target) return 'NO_SELECT:' + selects.length;
  const set = ${SET_INPUT};
  set(target, 'chatting');
  return 'ok';
})()`);
await sleep(500);
snapshot = await db();
const afterChange = snapshot.applications?.[0]?.status;
check('状态改为 chatting', afterChange === 'chatting', `${afterChange} / ${selectChanged}`);

await evaluate(`(() => { document.body.focus(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); return 'ok'; })()`);
await sleep(600);
snapshot = await db();
check('Ctrl+Z 撤销回 applied', snapshot.applications?.[0]?.status === 'applied', String(snapshot.applications?.[0]?.status));

await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true })); 'ok'`);
await sleep(600);
snapshot = await db();
check('Ctrl+Shift+Z 重做回 chatting', snapshot.applications?.[0]?.status === 'chatting', String(snapshot.applications?.[0]?.status));

// 4) 设置页：版本号 / 上次备份 展示
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 'ok'`);
await sleep(300);
await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('title') || '') === '设置' || b.textContent.includes('设置'));
  if (btn) btn.click();
  return 'ok';
})()`);
await sleep(500);
const about = await evaluate(`(() => {
  const text = document.querySelector('.drawer')?.textContent || '';
  return { version: /v\\d+\\.\\d+\\.\\d+/.exec(text)?.[0] || '', hasBackup: text.includes('上次备份'), hasRollback: text.includes('迁移回滚点') };
})()`);
check('设置页显示真实版本号', about.version === 'v0.4.1', about.version);
check('设置页显示「上次备份」', about.hasBackup);
check('设置页显示「迁移回滚点」', about.hasRollback);

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(join(OUT, 'settings.png'), Buffer.from(shot.data, 'base64'));

console.log(results.join('\n'));
console.log(`\n${results.filter((r) => r.startsWith('✓')).length}/${results.length} 通过`);

ws.close();
child.kill();
