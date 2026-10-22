/**
 * T-QB 浏览器冒烟：在真实产物上验证「题库体验修复」四条都能用。
 *
 * 单测能证明「函数算得对」，证明不了「按钮点了有反应、撤销真的整批回退」。
 * 这个脚本用 CDP 在 headless Edge 里点真实 DOM：
 *   ① 快记：3 题分别选 不会/模糊/会 + 改分类 → 一次落库写 1 场面经 + 3 题
 *   ② 概览卡：折叠态 2 场 2 卡、题干不进 DOM；场序按面试日期倒序；展开该场全量渲染
 *   ③ 行内编辑：改题干/掌握度/分类 → 库内更新且调度三字段字节级不变；⌘Z 回滚
 *   ④ 整批撤销：快记落库后按 ⌘Z → 面经壳与 3 题一起消失（不留空壳）
 *
 * 用法：node smoke-tqb.mjs（先 npm run build）
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const DIST = join(APP_DIR, 'dist', 'index.html');
const SHOT_DIR = join(APP_DIR, 'smoke-tqb');
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

  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(SHOT_DIR, `${name}.png`), Buffer.from(data, 'base64'));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 启动 */

const profileDir = join(tmpdir(), `jobdesk-tqb-${Date.now()}`);
const proc = spawn(
  edge,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--allow-file-access-from-files',
    '--window-size=1440,1100',
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
  height: 1100,
  deviceScaleFactor: 2,
  mobile: false,
});

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
}

/* ------------------------------------------------------------------ 页面内工具 */

const HELPERS = `window.__t = {
  setVal(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  },
  setSelect(el, v) {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  },
  enter(el) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  },
  cmdZ() {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }));
  },
  btn(text, scope) {
    const root = scope || document;
    return [...root.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === text) || null;
  },
  db() { return JSON.parse(localStorage.getItem('jobdesk.v1') || '{}'); },
  q(id) { return (this.db().questions || []).find((x) => x.id === id) || null; }
}; 'ok'`;

/* ------------------------------------------------------------------ 造数据 */

const fileUrl = `file:///${DIST.replace(/\\/g, '/')}`;
await page.send('Page.navigate', { url: fileUrl });
await sleep(1800);

// 先让应用自己写一次空骨架，拿到「它认可的」存储形状，再往里塞面经/题库
const seeded = await page.eval(`(() => {
  const raw = localStorage.getItem('jobdesk.v1');
  const db = JSON.parse(raw);
  const iso = '2026-10-20T10:00:00.000Z';
  const mk = (i, expId, mastery, category) => ({
    id: 'q-' + i,
    experienceId: expId,
    category: category,
    difficulty: 2,
    text: '第 ' + i + ' 题：手写 Promise.all 的边界',
    mastery: mastery,
    tags: [],
    nextReviewAt: '2026-10-21',
    reviewCount: i % 4,
    lastReviewedAt: '2026-10-19',
    createdAt: iso,
    updatedAt: iso,
  });
  db.companies = [
    { id: 'c1', name: '字节跳动', createdAt: iso },
    { id: 'c2', name: '阿里', createdAt: iso },
  ];
  db.applications = [];
  db.experiences = [
    {
      id: 'exp-b', applicationId: null, companyName: '字节跳动', jobTitle: '抖音前端', round: 2,
      interviewDate: '2026-10-18', result: 'pending', source: 'self', createdAt: iso, updatedAt: iso,
    },
    {
      id: 'exp-a', applicationId: null, companyName: '阿里', jobTitle: '前端', round: 1,
      interviewDate: '2026-10-22', result: 'pending', source: 'self', createdAt: iso, updatedAt: iso,
    },
  ];
  db.questions = [
    ...Array.from({ length: 20 }, (_, k) => mk(k + 1, 'exp-b', (k + 1) % 3, k % 2 === 0 ? 'algo' : null)),
    mk(101, 'exp-a', 0, 'concept'),
    mk(102, 'exp-a', 1, null),
    mk(103, 'exp-a', 2, 'project'),
  ];
  localStorage.setItem('jobdesk.v1', JSON.stringify(db));
  localStorage.setItem('jobdesk.v1.ui', JSON.stringify({ view: 'insights', insightsTab: 'interview' }));
  return { experiences: db.experiences.length, questions: db.questions.length };
})()`);
check('造数据：2 场面经 + 23 题', seeded.experiences === 2 && seeded.questions === 23, JSON.stringify(seeded));

await page.send('Page.reload');
await sleep(2000);
await page.eval(HELPERS);
await sleep(300);

/* ------------------------------------------------- ② 概览卡：折叠 / 场序 / 展开 */

const collapsed = await page.eval(`(() => ({
  groups: document.querySelectorAll('.qb__group').length,
  rows: document.querySelectorAll('.qb__row').length,
  heads: [...document.querySelectorAll('.qb__group-head')].map((h) => h.textContent.replace(/\\s+/g, ' ').trim()),
  hasQuestionText: ((document.querySelector('.qb') || {}).textContent || '').includes('第 1 题'),
}))()`);
check('默认每场一张概览卡（2 场 2 卡）', collapsed.groups === 2, `${collapsed.groups} 张`);
check('折叠态不渲染任何题目行', collapsed.rows === 0, `${collapsed.rows} 行`);
check('折叠态题干不进 DOM', collapsed.hasQuestionText === false);
check('场序 = 面试日期倒序（阿里 10-22 在前）', collapsed.heads[0]?.includes('阿里') === true, collapsed.heads[0] || '');
check('卡头带「N 题 · 其中不会 M」', collapsed.heads[0]?.includes('3 题 · 其中不会 1') === true, collapsed.heads[0] || '');
await page.shot('01-collapsed');

const expanded = await page.eval(`(() => {
  const heads = [...document.querySelectorAll('.qb__group-head')];
  heads[1].click(); // 字节跳动（20 题）
  return 'ok';
})()`);
await sleep(500);
const openState = await page.eval(`(() => ({
  rows: document.querySelectorAll('.qb__row').length,
  head: document.querySelectorAll('.qb__group-head')[1].textContent.replace(/\\s+/g, ' ').trim(),
  expandedFlag: document.querySelectorAll('.qb__group-head')[1].getAttribute('aria-expanded'),
}))()`);
check('展开该场 → 20 题全量渲染（不分页）', openState.rows === 20, `${openState.rows} 行，${expanded}`);
check('展开态 aria-expanded=true', openState.expandedFlag === 'true');
check('卡头计数口径 = 命中题数', openState.head.includes('20 题 · 其中不会 6') === true, openState.head);

const collapsedAgain = await page.eval(`(() => {
  document.querySelectorAll('.qb__group-head')[1].click();
  return 'ok';
})()`);
await sleep(400);
check(
  '再点收回 → 行与题干一起消失',
  (await page.eval(`document.querySelectorAll('.qb__row').length`)) === 0 &&
    (await page.eval(`((document.querySelector('.qb') || {}).textContent || '').includes('第 1 题')`)) === false,
  collapsedAgain,
);

/* ------------------------------------------------- ③ 行内编辑：一次保存 + 调度三字段不动 */

await page.eval(`document.querySelectorAll('.qb__group-head')[1].click(); 'ok'`);
await sleep(400);
const before = await page.eval(`(() => {
  const row = document.querySelectorAll('.qb__row')[0];
  row.querySelector('.qb__row-edit').click();
  return { q: window.__t.q('q-1') };
})()`);
await sleep(400);
const editorCount = await page.eval(`document.querySelectorAll('.qb__editor').length`);
check('点「编辑」进入行内编辑态（同时只有一行）', editorCount === 1, `${editorCount} 个编辑框`);

const editResult = await page.eval(`(async () => {
  const ed = document.querySelector('.qb__editor');
  window.__t.setVal(ed.querySelector('textarea[aria-label="题干"]'), '改过的题干');
  window.__t.setSelect(ed.querySelector('select[aria-label="掌握度"]'), '2');
  window.__t.setSelect(ed.querySelector('select[aria-label="分类"]'), 'project');
  window.__t.setVal(ed.querySelector('textarea[aria-label="我的回答"]'), '当时只说了思路');
  await new Promise((r) => setTimeout(r, 200));
  window.__t.btn('保存').click();
  await new Promise((r) => setTimeout(r, 500));
  const q = window.__t.q('q-1');
  return {
    after: q,
    editors: document.querySelectorAll('.qb__editor').length,
    toast: ((document.querySelector('.toast') || {}).textContent || '').trim(),
  };
})()`);
await sleep(300);
await page.shot('02-edited');
check('保存后退出编辑态', editResult.editors === 0, `${editResult.editors} 个编辑框`);
check(
  '库内四字段都更新了',
  editResult.after.text === '改过的题干' &&
    editResult.after.mastery === 2 &&
    editResult.after.category === 'project' &&
    editResult.after.myAnswer === '当时只说了思路',
  JSON.stringify({ t: editResult.after.text, m: editResult.after.mastery, c: editResult.after.category }),
);
check(
  '★ 调度三字段字节级不变（编辑 ≠ 复习了一遍）',
  editResult.after.reviewCount === before.q.reviewCount &&
    editResult.after.nextReviewAt === before.q.nextReviewAt &&
    editResult.after.lastReviewedAt === before.q.lastReviewedAt,
  `reviewCount ${before.q.reviewCount}→${editResult.after.reviewCount} · nextReviewAt ${editResult.after.nextReviewAt}`,
);
check('保存后 toast 提示可撤销', editResult.toast.includes('撤销') === true, editResult.toast);

const undone = await page.eval(`(async () => {
  window.__t.cmdZ();
  await new Promise((r) => setTimeout(r, 600));
  const q = window.__t.q('q-1');
  return {
    text: q.text,
    mastery: q.mastery,
    category: q.category,
    myAnswer: q.myAnswer,
    reviewCount: q.reviewCount,
    nextReviewAt: q.nextReviewAt,
  };
})()`);
check(
  '⌘Z 回滚编辑（四字段回旧值）',
  undone.text.startsWith('第 1 题') && undone.mastery === before.q.mastery && undone.category === before.q.category,
  JSON.stringify({ t: undone.text, m: undone.mastery, c: undone.category, a: undone.myAnswer }),
);
check('⌘Z 之后调度字段仍然没动', undone.reviewCount === before.q.reviewCount && undone.nextReviewAt === before.q.nextReviewAt);

/* ------------------------------------------------- ① 快记：一次落库 + 整批撤销 */

const quick = await page.eval(`(async () => {
  const openBtn = [...document.querySelectorAll('.qb__toolbar-actions button')].find((b) => /记面经/.test(b.textContent || ''));
  openBtn.click();
  await new Promise((r) => setTimeout(r, 500));
  const overlay = document.querySelector('.quick-note');
  if (!overlay) return { error: '快记弹层没打开' };
  window.__t.setVal(overlay.querySelector('input[placeholder="字节跳动"]'), '美团');
  const input = overlay.querySelector('.quick-note__input');
  for (const text of ['三题之一', '三题之二', '三题之三']) {
    window.__t.setVal(input, text);
    window.__t.enter(input);
    await new Promise((r) => setTimeout(r, 120));
  }
  const rows = [...overlay.querySelectorAll('.quick-note__item')];
  const picks = (i) => rows[i].querySelector('select[aria-label="第 ' + (i + 1) + ' 题掌握度"]');
  const cats = (i) => rows[i].querySelector('select[aria-label="第 ' + (i + 1) + ' 题分类"]');
  window.__t.setSelect(picks(1), '1');
  window.__t.setSelect(picks(2), '2');
  window.__t.setSelect(cats(1), 'project');
  await new Promise((r) => setTimeout(r, 200));
  return { rows: rows.length, before: window.__t.db().questions.length, label: window.__t.btn('记完了（3 题）') ? 'exact' : (overlay.querySelector('.quick-note__actions .btn--primary') || {}).textContent };
})()`);
check('快记弹层：3 行待记（Enter 只进列表）', quick.rows === 3, JSON.stringify(quick));
await page.shot('03-quicknote');

const committed = await page.eval(`(async () => {
  const btn = document.querySelector('.quick-note__actions .btn--primary');
  btn.click();
  await new Promise((r) => setTimeout(r, 700));
  const db = window.__t.db();
  const exp = db.experiences.find((e) => e.companyName === '美团');
  const mine = db.questions.filter((q) => exp && q.experienceId === exp.id);
  return {
    closed: !document.querySelector('.quick-note'),
    experiences: db.experiences.length,
    questions: db.questions.length,
    mastery: mine.map((q) => q.mastery),
    category: mine.map((q) => q.category),
    texts: mine.map((q) => q.text),
  };
})()`);
check('点「记完了」→ 弹层关闭', committed.closed === true, JSON.stringify({ before: quick.before }));
check('一次落库：新增 1 场面经 + 3 题', committed.experiences === 3 && committed.questions === 26, `${committed.experiences} 场 / ${committed.questions} 题`);
check(
  '逐题掌握度 / 分类按选择写入（0/1/2 + project/未分类）',
  JSON.stringify(committed.mastery) === '[0,1,2]' && committed.category[1] === 'project' && committed.category[0] === null,
  JSON.stringify({ m: committed.mastery, c: committed.category }),
);
await page.shot('04-recorded');

const rolledBack = await page.eval(`(async () => {
  window.__t.cmdZ();
  await new Promise((r) => setTimeout(r, 700));
  const db = window.__t.db();
  return {
    experiences: db.experiences.length,
    questions: db.questions.length,
    hasShell: db.experiences.some((e) => e.companyName === '美团'),
    groups: document.querySelectorAll('.qb__group').length,
  };
})()`);
check(
  '★ ⌘Z 整批回退：3 题与面经壳一起消失（不留 0 题空壳）',
  rolledBack.experiences === 2 && rolledBack.questions === 23 && rolledBack.hasShell === false,
  `${rolledBack.experiences} 场 / ${rolledBack.questions} 题`,
);
check('撤销后面经卡也回到 2 张', rolledBack.groups === 2, `${rolledBack.groups} 张`);

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
