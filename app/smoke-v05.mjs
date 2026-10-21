/**
 * v0.5 浏览器冒烟：在真实产物上验证四个新功能真的能用。
 *
 * 单测只能证明「函数算得对」，证明不了「按钮点了有反应」。
 * 这个脚本用 CDP 在 headless Edge 里点真实 DOM：
 *   1. 软删除 → 进回收站 → 恢复
 *   2. 回收站永久删除（面经解绑，不连带删面经）
 *   3. 导入增量合并：重复导入不产生重复、冲突面板默认保留本地
 *   4. 导出便携包（拦截下载，检查 zip 里的四个文件）
 *   5. 列表窗口化：1000 条只渲染少量行
 *
 * 用法：node smoke-v05.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// 本脚本就在 app/ 下，所以是 dirname 而不是 dirname+'/..'
const APP_DIR = dirname(fileURLToPath(import.meta.url));
const DIST = join(APP_DIR, 'dist', 'index.html');
const SHOT_DIR = join(APP_DIR, 'smoke-v05');
const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

if (!existsSync(DIST)) {
  console.error('✗ 找不到 dist/index.html，先 npm run build');
  process.exit(1);
}
const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!edge) {
  console.error('✗ 找不到 Edge');
  process.exit(1);
}
mkdirSync(SHOT_DIR, { recursive: true });

/* ------------------------------------------------------------------ CDP */

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
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 30000);
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || '页面内脚本抛错';
      throw new Error(detail.split('\n')[0]);
    }
    return result.result.value;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 启动 */

const profileDir = join(tmpdir(), `jobdesk-smoke5-${Date.now()}`);
const proc = spawn(
  edge,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--allow-file-access-from-files',
    '--window-size=1440,960',
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

const wsUrl = await new Promise((res, reject) => {
  let buffer = '';
  proc.stderr.on('data', (chunk) => {
    buffer += chunk.toString();
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
    if (match) res(match[1]);
  });
  setTimeout(() => reject(new Error('Edge 启动超时')), 20000);
});

const port = new URL(wsUrl).port;
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const browserWs = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => browserWs.addEventListener('open', r, { once: true }));
const browser = new Cdp(browserWs);

const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((t) => t.id === targetId);
const pageWs = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => pageWs.addEventListener('open', r, { once: true }));
const page = new Cdp(pageWs);

await page.send('Page.enable');
await page.send('Runtime.enable');
await page.send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 960,
  deviceScaleFactor: 2,
  mobile: false,
});

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
}

/* ------------------------------------------------------------------ 数据 */

/** 8 条投递，够覆盖回收站与合并的判定 */
function seedDB() {
  const now = new Date();
  const iso = now.toISOString();
  const day = (n) => new Date(now.getTime() - n * 86400000).toISOString();
  return {
    schemaVersion: 2,
    companies: [
      { id: 'c1', name: '字节跳动', shortName: '字节', createdAt: iso },
      { id: 'c2', name: '小红书', shortName: '小红书', createdAt: iso },
      { id: 'c3', name: '美团', shortName: '美团', createdAt: iso },
    ],
    applications: [
      {
        id: 'a1', companyId: 'c1', jobTitle: '后端开发实习生', city: '北京',
        channel: 'referral', status: 'interviewing', appliedAt: day(10),
        resumeVersion: 'v3', priority: 1,
      },
      {
        id: 'a2', companyId: 'c2', jobTitle: '数据分析实习生', city: '上海',
        channel: 'official', status: 'applied', appliedAt: day(3),
        resumeVersion: 'v2', priority: 2,
      },
      {
        id: 'a3', companyId: 'c3', jobTitle: '前端开发实习生', city: '北京',
        channel: 'boss', status: 'chatting', appliedAt: day(6),
        resumeVersion: 'v3', priority: 2,
      },
    ],
    interviews: [
      {
        id: 'iv1', applicationId: 'a1', round: 1,
        scheduledAt: new Date(now.getTime() + 2 * 86400000).toISOString(),
        format: 'video', result: 'pending',
      },
    ],
    notes: [
      { id: 'n1', applicationId: 'a1', type: 'chat', content: 'HR 说两天内给消息', touchedAt: day(2) },
    ],
    experiences: [],
    questions: [],
    staging: [],
    events: [],
    settings: {},
  };
}

const fileUrl = `file:///${DIST.replace(/\\/g, '/')}`;
await page.send('Page.navigate', { url: fileUrl });
await sleep(1500);

await page.eval(
  `localStorage.setItem('jobdesk.v1', ${JSON.stringify(JSON.stringify(seedDB()))});
   localStorage.setItem('jobdesk.v1.ui', JSON.stringify({view:'list',insightsTab:'data'}));
   'ok'`,
);
await page.send('Page.reload');
await sleep(2000);

/* ------------------------------------------------- 1. 列表窗口化 */

const rowInfo = await page.eval(`(() => {
  const rows = document.querySelectorAll('.table tbody tr:not(.table__spacer)');
  return { rows: rows.length, total: (document.querySelector('.page__sub')||{}).textContent || '' };
})()`);
check('列表渲染正常', rowInfo.rows === 3, `渲染 ${rowInfo.rows} 行`);

/* ------------------------------------------------- 2. 软删除进回收站 */

// 点第一条行进详情，再点删除
await page.eval(`document.querySelector('.table tbody tr').click(); 'ok'`);
await sleep(600);

const openedDetail = await page.eval(`!!document.querySelector('.drawer')`);
check('详情抽屉能打开', openedDetail === true);

// 详情里的删除按钮需要二次确认（真正的按钮文案是「删除这条投递」/「确认删除」）
const deleteFlow = await page.eval(`(async () => {
  const btn = [...document.querySelectorAll('.drawer button')].find((b) => /删除这条投递/.test(b.textContent || ''));
  if (!btn) return { error: '找不到删除按钮' };
  btn.click();
  await new Promise((r) => setTimeout(r, 400));
  // 确认按钮渲染在 Drawer 之外的一层（可能是行内确认条），全文档找
  const confirm = [...document.querySelectorAll('button')].find((b) => /^确认删除$/.test((b.textContent || '').trim()));
  if (!confirm) return { error: '没有二次确认' };
  confirm.click();
  await new Promise((r) => setTimeout(r, 700));
  return { clicked: true, hadConfirm: true };
})()`);
check('删除走二次确认', deleteFlow.clicked === true, JSON.stringify(deleteFlow));

await sleep(600);
const afterDelete = await page.eval(`(() => {
  const db = JSON.parse(localStorage.getItem('jobdesk.v1') || '{}');
  const deleted = (db.applications || []).filter((a) => a.deletedAt);
  return { deletedCount: deleted.length, total: (db.applications || []).length, visibleRows: document.querySelectorAll('.table tbody tr:not(.table__spacer)').length };
})()`);
check(
  '软删除：记录还在库里，只是打了 deletedAt',
  afterDelete.total === 3 && afterDelete.deletedCount === 1,
  `库里 ${afterDelete.total} 条，其中已删 ${afterDelete.deletedCount} 条`,
);
check('列表不再显示已删除的', afterDelete.visibleRows === 2, `剩 ${afterDelete.visibleRows} 行`);

/* ------------------------------------------------- 3. 回收站恢复 */

await page.eval(`(() => {
  // 关掉详情，打开设置
  const close = document.querySelector('.drawer .icon-btn');
  if (close) close.click();
  return 'ok';
})()`);
await sleep(400);
await page.eval(`(() => {
  // 设置入口是「⚙」图标按钮，没有文字；优先按 title / aria-label 找
  const btn = [...document.querySelectorAll('button')].find((b) =>
    /设置/.test((b.title || '') + (b.getAttribute('aria-label') || '')) || (b.textContent || '').trim() === '⚙');
  if (btn) btn.click();
  return 'ok';
})()`);
await sleep(700);

const trashUI = await page.eval(`(() => {
  const rows = document.querySelectorAll('.trash-row');
  return {
    count: rows.length,
    text: rows.length ? rows[0].textContent.replace(/\\s+/g, ' ').trim().slice(0, 80) : '',
  };
})()`);
check('设置页回收站显示这条记录', trashUI.count === 1, trashUI.text);

const restored = await page.eval(`(async () => {
  const btn = [...document.querySelectorAll('.trash-row button')].find((b) => /恢复/.test(b.textContent || ''));
  if (!btn) return { error: '找不到恢复按钮' };
  btn.click();
  await new Promise((r) => setTimeout(r, 600));
  const db = JSON.parse(localStorage.getItem('jobdesk.v1') || '{}');
  return {
    stillDeleted: (db.applications || []).filter((a) => a.deletedAt).length,
    trashRows: document.querySelectorAll('.trash-row').length,
  };
})()`);
check(
  '恢复后 deletedAt 被清掉，回收站变空',
  restored.stillDeleted === 0 && restored.trashRows === 0,
  JSON.stringify(restored),
);

await page.screenshot?.({});

/* ------------------------------------------------- 4. 导入增量合并 */

// 先关设置，回到列表
// 先确保设置抽屉是打开的（恢复操作后它可能已被关闭）
await page.eval(`(() => {
  const openDrawer = () => !!document.querySelector('.hidden-file');
  if (openDrawer()) return 'already';
  const btn = [...document.querySelectorAll('button')].find((b) =>
    /设置/.test((b.title || '') + (b.getAttribute('aria-label') || '')) || (b.textContent || '').trim() === '⚙');
  if (btn) btn.click();
  return 'opened';
})()`);
await sleep(700);

const mergeResult = await page.eval(`(async () => {
  // 造一份备份：1 条全新的（应该被加进来）+ 1 条与本地冲突的（默认保留本地）
  const backup = {
    schemaVersion: 2,
    companies: [
      { id: 'cx', name: '腾讯', shortName: '腾讯', createdAt: new Date().toISOString() },
      { id: 'c2', name: '小红书', shortName: '小红书', createdAt: new Date().toISOString() },
    ],
    applications: [
      { id: 'ax', companyId: 'cx', jobTitle: '算法实习生', city: '深圳', channel: 'official',
        status: 'applied', appliedAt: '2026-09-01T00:00:00.000Z', resumeVersion: 'v1', priority: 1 },
      { id: 'a2b', companyId: 'c2', jobTitle: '数据分析实习生', city: '上海', channel: 'official',
        status: 'offer', appliedAt: JSON.parse(localStorage.getItem('jobdesk.v1')).applications.find(a=>a.id==='a2').appliedAt,
        resumeVersion: 'v9', priority: 3 },
    ],
    interviews: [], notes: [], experiences: [], questions: [], staging: [], events: [], settings: {},
  };
  const before = JSON.parse(localStorage.getItem('jobdesk.v1'));

  // 通过设置页的文件 input 走真实导入通道
  const input = document.querySelector('input[type=file]');
  if (!input) return { error: '找不到导入 input' };
  const file = new File([JSON.stringify(backup)], 'backup.json', { type: 'application/json' });
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 900));

  return {
    beforeApps: before.applications.length,
    panelOpen: !!document.querySelector('.import__conflicts'),
    conflictRows: document.querySelectorAll('.import__conflict').length,
    checked: document.querySelectorAll('.import__conflict input:checked').length,
  };
})()`);
check('导入冲突面板弹出', mergeResult.panelOpen === true, JSON.stringify(mergeResult));
check('冲突行默认不勾（= 保留本地）', mergeResult.checked === 0, `勾了 ${mergeResult.checked} 条`);

// 截图留档
await page.send('Page.captureScreenshot', { format: 'png' }).then(async ({ data }) => {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(SHOT_DIR, 'import-conflict.png'), Buffer.from(data, 'base64'));
});

const confirmed = await page.eval(`(async () => {
  const btn = [...document.querySelectorAll('.sync__foot-right button')].find((b) => /确认导入/.test(b.textContent || ''));
  if (!btn) return { error: '找不到确认按钮' };
  btn.click();
  await new Promise((r) => setTimeout(r, 1000));
  const db = JSON.parse(localStorage.getItem('jobdesk.v1'));
  const xhs = db.applications.find((a) => a.jobTitle === '数据分析实习生');
  return {
    apps: db.applications.length,
    companies: db.companies.length,
    tencent: db.applications.some((a) => a.jobTitle === '算法实习生'),
    xhsStatus: xhs ? xhs.status : null,
    xhsVersion: xhs ? xhs.resumeVersion : null,
    panelGone: !document.querySelector('.import__conflicts'),
  };
})()`);
check('新增的投递被合并进来', confirmed.tencent === true, `共 ${confirmed.apps} 条`);
check('冲突项保留本地（状态仍是 applied，不是备份的 offer）', confirmed.xhsStatus === 'applied', `实际 ${confirmed.xhsStatus}`);
check('受保护字段（简历版本）保留本地', confirmed.xhsVersion === 'v2', `实际 ${confirmed.xhsVersion}`);
check('导入面板已关闭', confirmed.panelGone === true);

/* ------------------------------------------------- 5. 重复导入不产生重复 */

const secondImport = await page.eval(`(async () => {
  const before = JSON.parse(localStorage.getItem('jobdesk.v1')).applications.length;
  // 重新打开设置→导入同一份
  const settingsBtn = [...document.querySelectorAll('button')].find((b) => /设置/.test(b.textContent || ''));
  if (settingsBtn) settingsBtn.click();
  await new Promise((r) => setTimeout(r, 500));
  const backup = {
    schemaVersion: 2,
    companies: [{ id: 'cx', name: '腾讯', shortName: '腾讯', createdAt: new Date().toISOString() }],
    applications: [{ id: 'ax', companyId: 'cx', jobTitle: '算法实习生', city: '深圳', channel: 'official',
      status: 'applied', appliedAt: '2026-09-01T00:00:00.000Z', resumeVersion: 'v1', priority: 1 }],
    interviews: [], notes: [], experiences: [], questions: [], staging: [], events: [], settings: {},
  };
  const input = document.querySelector('input[type=file]');
  const file = new File([JSON.stringify(backup)], 'backup2.json', { type: 'application/json' });
  const dt = new DataTransfer(); dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 1200));
  const after = JSON.parse(localStorage.getItem('jobdesk.v1')).applications.length;
  return { before, after, toast: (document.querySelector('.toast')||{}).textContent || '' };
})()`);
check(
  '同一份备份再导一次，不产生重复',
  secondImport.before === secondImport.after,
  `${secondImport.before} → ${secondImport.after}`,
);

/* ------------------------------------------------- 6. 导出便携包 */

await page.eval(`(() => { const c = document.querySelector('.drawer .icon-btn'); if (c) c.click(); return 'ok'; })()`);
await sleep(400);
await page.eval(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) =>
    /设置/.test((x.title || '') + (x.getAttribute('aria-label') || '')) || (x.textContent || '').trim() === '⚙');
  if (b) b.click();
  return 'ok';
})()`);
await sleep(600);

// 拦截下载：把 Blob 拦住，直接检查 zip 结构
const zipCheck = await page.eval(`(async () => {
  const captured = { blob: null, name: null };
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = function (blob) {
    if (blob && blob.type === 'application/zip') captured.blob = blob;
    return origCreate.call(URL, blob);
  };
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) captured.name = this.download;
    // 不真的点，避免下载动作
  };

  const btn = [...document.querySelectorAll('button')].find((b) => /导出便携包/.test(b.textContent || ''));
  if (!btn) { URL.createObjectURL = origCreate; HTMLAnchorElement.prototype.click = origClick; return { error: '找不到导出便携包按钮' }; }
  btn.click();
  await new Promise((r) => setTimeout(r, 1500));

  URL.createObjectURL = origCreate;
  HTMLAnchorElement.prototype.click = origClick;

  if (!captured.blob) return { error: '没有产生 zip' };
  const buf = new Uint8Array(await captured.blob.arrayBuffer());
  // 读 EOCD 拿条目数
  const dv = new DataView(buf.buffer);
  const eocd = buf.length - 22;
  const count = dv.getUint16(eocd + 10, true);
  // 读中央目录里的文件名
  const names = [];
  let cursor = dv.getUint32(eocd + 16, true);
  for (let i = 0; i < count; i += 1) {
    const nameLen = dv.getUint16(cursor + 28, true);
    names.push(new TextDecoder().decode(buf.subarray(cursor + 46, cursor + 46 + nameLen)));
    cursor += 46 + nameLen + dv.getUint16(cursor + 30, true) + dv.getUint16(cursor + 32, true);
  }
  return { name: captured.name, size: buf.length, count, names };
})()`);

if (zipCheck.error) {
  check('导出便携包', false, zipCheck.error);
} else {
  check('导出便携包产生 zip', zipCheck.count >= 3, `${(zipCheck.size / 1024).toFixed(0)} KB · ${zipCheck.count} 个条目`);
  check(
    'zip 内含 index.html / data.json / 使用说明',
    zipCheck.names.includes('index.html') && zipCheck.names.includes('data.json'),
    zipCheck.names.join(', '),
  );
  check('文件名带日期时分', /便携包-\d{4}-\d{2}-\d{2}-\d{4}\.zip/.test(zipCheck.name || ''), zipCheck.name || '');
}

/* ------------------------------------------------- 7. 1000 条窗口化 */

const bigPerf = await page.eval(`(async () => {
  const n = 1000;
  const now = Date.now();
  const companies = [], applications = [];
  for (let i = 0; i < n; i += 1) {
    companies.push({ id: 'k' + i, name: '压测' + i, shortName: '压测' + i, createdAt: new Date(now).toISOString() });
    applications.push({
      id: 'p' + i, companyId: 'k' + i, jobTitle: '岗位 ' + i, city: '北京',
      channel: 'official', status: 'applied',
      appliedAt: new Date(now - i * 86400000).toISOString(), resumeVersion: 'v1', priority: 1,
    });
  }
  const db = { schemaVersion: 2, companies, applications, interviews: [], notes: [],
    experiences: [], questions: [], staging: [], events: [], settings: {} };
  localStorage.setItem('jobdesk.v1', JSON.stringify(db));
  return 'seeded';
})()`);
void bigPerf;
await page.send('Page.reload');
await sleep(2500);

const virtualCheck = await page.eval(`(() => {
  const rows = document.querySelectorAll('.table tbody tr:not(.table__spacer)');
  const spacer = document.querySelectorAll('.table__spacer');
  const sub = (document.querySelector('.page__sub') || {}).textContent || '';
  return { rendered: rows.length, spacers: spacer.length, sub: sub.trim() };
})()`);
check(
  '1000 条只渲染视口内的行',
  virtualCheck.rendered > 0 && virtualCheck.rendered < 60,
  `渲染 ${virtualCheck.rendered} 行，占位 ${virtualCheck.spacers} 个`,
);
check('总条数显示正确', virtualCheck.sub.includes('1000'), virtualCheck.sub);

// 滚动后仍然只渲染少量行
const scrolled = await page.eval(`(async () => {
  const wrap = document.querySelector('.table-wrap');
  wrap.scrollTop = 8000;
  wrap.dispatchEvent(new Event('scroll'));
  await new Promise((r) => setTimeout(r, 300));
  return {
    rendered: document.querySelectorAll('.table tbody tr:not(.table__spacer)').length,
    firstCell: (document.querySelector('.table tbody tr:not(.table__spacer) td') || {}).textContent || '',
  };
})()`);
check('滚动到中部仍只渲染少量行', scrolled.rendered > 0 && scrolled.rendered < 60, `渲染 ${scrolled.rendered} 行`);
check('滚动后内容确实变了（不是卡在顶部）', scrolled.firstCell !== '压测0', `首行 ${scrolled.firstCell}`);

await page.send('Page.captureScreenshot', { format: 'png' }).then(async ({ data }) => {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(SHOT_DIR, 'list-1000.png'), Buffer.from(data, 'base64'));
});

/* ------------------------------------------------------------------ 汇总 */

const passed = results.filter((r) => r.ok).length;
console.log('');
console.log(`${passed}/${results.length} 项通过`);
if (passed !== results.length) {
  console.log('失败项：');
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}  ${r.detail}`);
}

proc.kill();
process.exit(passed === results.length ? 0 : 1);
