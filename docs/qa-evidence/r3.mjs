/**
 * Round 3 定点复验：R-6 轮次快选 / R-7 导出文件名 / R-10 简历版本列 + 城市多选
 * 零依赖：Node 22 内置 WebSocket + Edge headless + CDP 直连 + node:http 静态服务
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const DIST = path.resolve('app/dist');
const SHOTS = path.resolve('docs/screenshots');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 5199;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ 结果收集 */
const results = [];
function check(name, expected, actual) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual);
  results.push({ name, expected, actual, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n        期望: ${JSON.stringify(expected)}\n        实际: ${JSON.stringify(actual)}`}`);
  return pass;
}
const log = (msg) => console.log(`-- ${msg}`);

/* ------------------------------------------------------------ 静态服务 */
function serve() {
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    const file = path.join(DIST, url === '/' ? 'index.html' : url);
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
  });
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)));
}

/* ---------------------------------------------------------------- CDP */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else {
        for (const h of this.handlers.get(msg.method) || []) h(msg.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) {
    const list = this.handlers.get(method) || [];
    list.push(fn);
    this.handlers.set(method, list);
  }
  async eval(js) {
    const r = await this.send('Runtime.evaluate', {
      expression: js,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error('EVAL: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(SHOTS, name);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
}

const HELP = `
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const $ = (s, r = document) => r.querySelector(s);
const txt = (el) => (el ? (el.innerText || '').trim() : '');
const byText = (sel, t) => $$(sel).find((el) => txt(el).indexOf(t) >= 0);
const clickText = (sel, t) => { const el = byText(sel, t); if (!el) throw new Error('找不到 ' + t); el.click(); return true; };
const rows = () => $$('table.table tbody tr');
const dbNow = () => JSON.parse(localStorage.getItem('jobdesk.v1') || 'null');
const localToday = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
const triggerText = () => { const el = $('.multiselect__trigger'); return el ? txt(el).split('\\n')[0].trim() : ''; };
function setVal(el, v) {
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
`;

let cdp;

async function act(js, wait = 320) {
  const out = await cdp.eval(`(() => { ${HELP} return (${js}); })()`);
  await sleep(wait);
  return out;
}
async function read(js) {
  return cdp.eval(`(() => { ${HELP} return (${js}); })()`);
}
async function key(key, code, vk, modifiers = 0) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await sleep(280);
}
const esc = () => key('Escape', 'Escape', 27);
const ctrlZ = () => key('z', 'KeyZ', 90, 2);

async function boot() {
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-r3-'));
  const edge = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--remote-debugging-port=9333`,
    `--user-data-dir=${udd}`,
    '--window-size=1440,900',
    'about:blank',
  ]);
  let version = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch('http://127.0.0.1:9333/json/version');
      version = await res.json();
      break;
    } catch {
      await sleep(250);
    }
  }
  if (!version) throw new Error('Edge 没起来');
  // 必须连 page 目标，browser 目标没有 Page/Runtime 域
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有 page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const client = new CDP(ws);
  client.edge = edge;
  client.udd = udd;
  client.ws = ws;
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => null);
  cdp = client;
  return client;
}

async function goto(url) {
  await cdp.send('Page.navigate', { url });
  for (let i = 0; i < 80; i += 1) {
    await sleep(150);
    const ready = await cdp.eval('document.readyState').catch(() => '');
    if (ready === 'complete') break;
  }
  await sleep(500);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => null);
}

async function main() {
  const server = await serve();
  const client = await boot();
  try {
    /* ------------------------------------------------ 载入示例数据 */
    await goto(`http://127.0.0.1:${PORT}/`);
    log('首屏');
    check('S0-1 欢迎层出现', true, await read(`!!$('.welcome')`));
    await act(`clickText('.welcome button', '示例数据')`, 600);
    check('S0-3 示例 8 条', 8, await read(`dbNow().applications.length`));
    await act(`clickText('.nav__item', '看板')`, 420);
    check('S0-2 看板出现', true, await read(`!!$('.board')`));

    /* --------------------------------- 注入一条「没有城市」的投递 */
    const today = await read(`localToday()`);
    await act(`(() => {
      const db = dbNow();
      const now = new Date().toISOString();
      db.companies.push({ id: 'c-qa-empty', name: '测试公司-空城', createdAt: now });
      db.applications.push({
        id: 'a-qa-empty', companyId: 'c-qa-empty', jobTitle: '前端实习生', jobType: 'daily',
        city: '', channel: 'other', resumeVersion: '', status: 'applied', appliedAt: '${today}',
        statusChangedAt: now, lastActivityAt: now, silenceOverride: null, rejectedAtRound: null,
        createdAt: now, updatedAt: now,
      });
      localStorage.setItem('jobdesk.v1', JSON.stringify(db));
      return db.applications.length;
    })()`);
    await goto(`http://127.0.0.1:${PORT}/`);
    check('S0-4 注入后 9 条', 9, await read(`dbNow().applications.length`));
    await act(`clickText('.nav__item', '看板')`, 420);

    /* ============================================ R-6 已挂轮次（入口 1） */
    log('R-6 标为已挂 → 先落库 → 非阻塞 chip');
    const target = await read(`(() => {
      const col = $$('.board__col').find((c) => txt(c.querySelector('.board__col-name')) === '已投递');
      const card = col.querySelector('.app-card');
      return { company: txt(card.querySelector('.app-card__company')), job: txt(card.querySelector('.app-card__job')) };
    })()`);
    log(`目标记录：${target.company} · ${target.job}`);
    await act(`(() => {
      const col = $$('.board__col').find((c) => txt(c.querySelector('.board__col-name')) === '已投递');
      col.querySelector('.app-card').click();
    })()`, 420);
    check('R6-1 抽屉打开', true, await read(`!!$('.drawer')`));
    check('R6-2 抽屉状态 chip=已投递', '已投递', await read(`txt($('.drawer__chips .chip--status'))`));

    await act(`clickText('.drawer__actions .btn', '标为已挂')`, 420);
    check('R6-3 内联出现轮次快选', true, await read(`!!$('.reject-picker')`));
    check(
      'R6-4 快选 5 个档位',
      ['第 1 轮', '第 2 轮', '第 3 轮', 'HR 面', '不记得了'],
      await read(`$$('.reject-picker .chip-toggle').map((el) => txt(el))`),
    );
    check('R6-5 有「先不记」', true, await read(`!!byText('.reject-picker .link-btn', '先不记')`));
    check(
      'R6-6 状态先落库 rejected / round=null',
      { status: 'rejected', round: null },
      await read(`(() => {
        const db = dbNow();
        const c = db.companies.find((x) => x.name === ${JSON.stringify(target.company)});
        const app = db.applications.filter((x) => x.companyId === c.id).pop();
        return { status: app.status, round: app.rejectedAtRound ?? null };
      })()`),
    );
    await cdp.shot('r3-01-reject-round-chips.png');

    await act(`clickText('.reject-picker .link-btn', '先不记')`, 300);
    check('R6-7 「先不记」收起快选', false, await read(`!!$('.reject-picker')`));
    check(
      'R6-8 不选也仍是 rejected / round=null',
      { status: 'rejected', round: null },
      await read(`(() => {
        const db = dbNow();
        const c = db.companies.find((x) => x.name === ${JSON.stringify(target.company)});
        const app = db.applications.filter((x) => x.companyId === c.id).pop();
        return { status: app.status, round: app.rejectedAtRound ?? null };
      })()`),
    );

    /* ============================== R-6 关抽屉重开：入口 1 的「轮次未记」 */
    await esc();
    check('R6-9 Esc 关抽屉', false, await read(`!!$('.drawer')`));
    await act(`clickText('.nav__item', '列表')`, 420);
    await act(`(() => {
      const row = rows().find((r) => txt(r.cells[0]).indexOf(${JSON.stringify(target.company)}) >= 0);
      if (!row) throw new Error('列表里找不到该行');
      row.click();
    })()`, 420);
    check('R6-10 重开后状态=已挂', '已挂', await read(`txt($('.drawer__chips .chip--status'))`));
    check('R6-11 顶部 chip=轮次未记', '轮次未记', await read(`txt($('.drawer__chips button.chip'))`));
    check(
      'R6-12 概览补录入口文案',
      true,
      await read(`(() => { const el = $('.reject-block .link-btn'); return !!el && txt(el).indexOf('轮次未记 · 点这里补录') >= 0; })()`),
    );

    /* ============================================ R-6 入口 2：概览补录 */
    log('R-6 概览补录「第 2 轮」→「HR 面」');
    await act(`clickText('.reject-block .chip-toggle', '第 2 轮')`, 420);
    check('R6-13 点「第 2 轮」落库 = 2', 2, await read(`(() => {
      const db = dbNow();
      const c = db.companies.find((x) => x.name === ${JSON.stringify(target.company)});
      return db.applications.filter((x) => x.companyId === c.id).pop().rejectedAtRound;
    })()`));
    check('R6-14 顶部 chip=第 2 轮', '第 2 轮', await read(`txt($('.drawer__chips button.chip'))`));
    check(
      'R6-15 概览标签=第 2 轮',
      '第 2 轮',
      await read(`txt($('.reject-block .chip--quiet'))`),
    );

    await act(`clickText('.reject-block .chip-toggle', 'HR 面')`, 420);
    check('R6-16 点「HR 面」落库 = 4', 4, await read(`(() => {
      const db = dbNow();
      const c = db.companies.find((x) => x.name === ${JSON.stringify(target.company)});
      return db.applications.filter((x) => x.companyId === c.id).pop().rejectedAtRound;
    })()`));
    check('R6-17 HR 面展示为「HR 面」不裸「第 4 轮」', 'HR 面', await read(`txt($('.drawer__chips button.chip'))`));
    check(
      'R6-18 概览标签=第 4 轮（HR 面）',
      '第 4 轮（HR 面）',
      await read(`txt($('.reject-block .chip--quiet'))`),
    );

    /* ============================================ R-6 入口 3：列表状态列 */
    await esc();
    const listRound = await read(`(() => {
      const row = rows().find((r) => txt(r.cells[0]).indexOf(${JSON.stringify(target.company)}) >= 0);
      const cell = row.cells[row.cells.length - 1];
      return { status: txt(cell.querySelector('.table__status')), round: txt(cell.querySelector('.table__round-done')) };
    })()`);
    check('R6-19 列表状态列=已挂 + HR 面', { status: '已挂', round: 'HR 面' }, listRound);
    await cdp.shot('r3-02-list-round.png');

    /* ============================== R-6 联带：改状态撤销后轮次也回滚 */
    log('撤销联动：已挂 → Ctrl+Z → 状态与 rejectedAtRound 一起回滚');
    const second = await read(`(() => {
      const row = rows().find((r) => txt(r.cells[0]).indexOf('测试公司-空城') >= 0);
      row.click();
      return txt(row.cells[0]);
    })()`, 400);
    await act(`clickText('.drawer__actions .btn', '标为已挂')`, 420);
    check('R6-20 第二条也变已挂', '已挂', await read(`txt($('.drawer__chips .chip--status'))`));
    await esc();
    await ctrlZ();
    const undoState = await read(`(() => {
      const db = dbNow();
      const c = db.companies.find((x) => x.name === '测试公司-空城');
      const app = db.applications.filter((x) => x.companyId === c.id).pop();
      return { status: app.status, round: app.rejectedAtRound ?? null };
    })()`);
    check('R6-21 撤销后回到 applied / round=null', { status: 'applied', round: null }, undoState);

    /* ==================================================== R-7 导出文件名 */
    log('R-7 导出文件名用本地日期');
    await act(`(() => { window.__dl = null; HTMLAnchorElement.prototype.click = function () { window.__dl = this.download; }; })()`, 120);
    await act(`$('.icon-btn[title="设置"]').click()`, 420);
    check('R7-1 设置抽屉打开', true, await read(`!!$('.drawer--settings')`));
    await act(`clickText('.drawer--settings button', '导出 JSON')`, 500);
    const dl = await read(`window.__dl`);
    check('R7-2 文件名模板', `求职工作台-备份-${today}.json`, dl);
    await cdp.shot('r3-03-export-filename.png');
    await esc();

    /* ============================================ R-10 简历版本列 + 排序 */
    log('R-10 列表第 5 列 = 简历版本，可排序');
    const heads = await read(`$$('thead th').map((el) => txt(el))`);
    check('R10-1 表头 9 列', 9, heads.length);
    check('R10-2 第 5 列是简历版本', '简历版本', heads[4]);
    check('R10-3 前后列位置', { c3: '渠道', c5: '投递日' }, { c3: heads[3], c5: heads[5] });

    const versions = () => read(`$$('thead th')[4].getAttribute('title'), rows().map((r) => txt(r.cells[4])), txt($$('thead th')[4])`);
    // 默认按沉默天数排序，先点一次「简历版本」→ desc
    await act(`$$('thead th')[4].click()`, 400);
    const desc = await read(`({ head: txt($$('thead th')[4]), vals: rows().map((r) => txt(r.cells[4])).filter((v) => v !== '—') })`);
    await act(`$$('thead th')[4].click()`, 400);
    const asc = await read(`({ head: txt($$('thead th')[4]), vals: rows().map((r) => txt(r.cells[4])).filter((v) => v !== '—') })`);
    check('R10-4 点表头出现排序箭头 ↓', true, desc.head.indexOf('↓') >= 0);
    check('R10-5 再点变 ↑', true, asc.head.indexOf('↑') >= 0);
    const monotone = (list, dir) => {
      for (let i = 1; i < list.length; i += 1) {
        const cmp = list[i - 1].localeCompare(list[i], 'zh-Hans-CN');
        if (dir === 'asc' ? cmp > 0 : cmp < 0) return false;
      }
      return true;
    };
    check('R10-6 降序有序', true, monotone(desc.vals, 'desc'));
    check('R10-7 升序有序', true, monotone(asc.vals, 'asc'));
    check('R10-8 版本列有多值', true, new Set(desc.vals).size >= 2);
    await cdp.shot('r3-04-version-column.png');

    /* 版本筛选联动 */
    await act(`(() => {
      const sel = $$('.filters select')[2];
      sel.value = ${JSON.stringify('v2-前端-基础版')};
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`, 400);
    const filtered = await read(`({ n: rows().length, vals: [...new Set(rows().map((r) => txt(r.cells[4])))] })`);
    check('R10-9 版本筛选生效', { vals: ['v2-前端-基础版'] }, { vals: filtered.vals });
    await act(`clickText('.filters .btn', '清除筛选')`, 380);
    check('R10-10 清除筛选恢复 9 条', 9, await read(`rows().length`));

    /* ================================================== R-10 城市多选 */
    log('R-10 城市多选');
    await act(`$('.multiselect__trigger').click()`, 320);
    check('R10-11 面板展开', true, await read(`!!$('.multiselect__panel')`));
    const cityOpts = await read(`$$('.ms-option').map((el) => ({ label: txt(el.querySelector('.ms-option__label')), count: Number(txt(el.querySelector('.ms-option__count'))) }))`);
    log(`城市选项：${JSON.stringify(cityOpts)}`);
    check('R10-12 含「未填城市」', 1, cityOpts.filter((o) => o.label === '未填城市').length);
    check('R10-13 空的归到未填城市（count=1）', 1, (cityOpts.find((o) => o.label === '未填城市') || {}).count);
    check('R10-14 选项条数之和=9', 9, cityOpts.reduce((s, o) => s + o.count, 0));
    check('R10-15 触发器初始「全部城市」', '全部城市', await read(`triggerText()`));

    const bj = cityOpts.find((o) => o.label === '北京').count;
    await act(`(() => {
      const el = $$('.ms-option').find((x) => txt(x.querySelector('.ms-option__label')) === '北京').querySelector('input');
      el.click();
    })()`, 420);
    const afterOne = await read(`({ trigger: triggerText(), n: rows().length })`);
    check('R10-16 单选后触发器显示城市名', '北京', afterOne.trigger);
    check('R10-17 单选后行数=该城市条数', bj, afterOne.n);

    // 定位探针：改一下关键词（rows 的 useMemo 依赖里有关键词）再清空，
    // 若行数变成 3，说明筛选逻辑本身对、只是 cityFilter 没进依赖数组
    await act(`setVal($('.filters input.input'), 'z')`, 380);
    await act(`setVal($('.filters input.input'), '')`, 380);
    check('R10-17b 探查：改动别的筛选后城市条件才生效', bj, await read(`rows().length`));

    const sh = cityOpts.find((o) => o.label === '上海').count;
    await act(`(() => {
      const el = $$('.ms-option').find((x) => txt(x.querySelector('.ms-option__label')) === '上海').querySelector('input');
      el.click();
    })()`, 420);
    const afterTwo = await read(`({ trigger: triggerText(), n: rows().length, active: $('.multiselect__trigger').classList.contains('is-active') })`);
    check('R10-18 多选后显示「已选 2 个城市」', '已选 2 个城市', afterTwo.trigger);
    check('R10-19 多选后行数=两城之和', bj + sh, afterTwo.n);
    check('R10-20 触发器高亮 is-active', true, afterTwo.active);
    await cdp.shot('r3-05-city-multiselect.png');

    await act(`$('.ms-backdrop').click()`, 320);
    check('R10-21 点空白处收起面板', false, await read(`!!$('.multiselect__panel')`));
    check('R10-22 收起后筛选仍生效', bj + sh, await read(`rows().length`));

    await act(`clickText('.filters .btn', '清除筛选')`, 420);
    check('R10-23 清除筛选把城市一起清掉', '全部城市', await read(`triggerText()`));
    check('R10-24 清除后回到 9 条', 9, await read(`rows().length`));
    check('R10-25 清除后无高亮', false, await read(`$('.multiselect__trigger').classList.contains('is-active')`));

    /* ============== Bug-3 修复复验：取消勾选 / 筛选态排序 / 组合筛选 */
    log('Bug-3 修复复验');
    await act(`$('.multiselect__trigger').click()`, 320);
    await act(`(() => { const el = $$('.ms-option').find((x) => txt(x.querySelector('.ms-option__label')) === '北京').querySelector('input'); el.click(); })()`, 400);
    check('R10-26 勾北京立刻只剩北京行', bj, await read(`rows().length`));
    const setA = await read(`rows().map((r) => txt(r.cells[0]))`);
    // 断言排序结果本身（不假设"一定变序"：北京这三行按公司降序恰好等于原始顺序）
    const sortedDesc = [...setA].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')).reverse();
    const sortedAsc = [...setA].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    await act(`$$('thead th')[0].click()`, 400);
    const descSort = await read(`({ n: rows().length, list: rows().map((r) => txt(r.cells[0])), head: txt($$('thead th')[0]) })`);
    check('R10-27 筛选态下点表头排序不丢结果集', bj, descSort.n);
    check('R10-28 筛选态下排序结果=公司降序', sortedDesc, descSort.list);
    check('R10-28b 表头出现 ↓', true, descSort.head.indexOf('↓') >= 0);
    await act(`$$('thead th')[0].click()`, 400);
    const ascSort = await read(`({ n: rows().length, list: rows().map((r) => txt(r.cells[0])), head: txt($$('thead th')[0]) })`);
    check('R10-28c 再点变升序且结果集不变', { n: bj, list: sortedAsc }, { n: ascSort.n, list: ascSort.list });
    check('R10-28d 表头出现 ↑', true, ascSort.head.indexOf('↑') >= 0);
    await act(`(() => { const el = $$('.ms-option').find((x) => txt(x.querySelector('.ms-option__label')) === '上海').querySelector('input'); el.click(); })()`, 400);
    check('R10-29 城市+排序叠加=两城之和', bj + sh, await read(`rows().length`));
    await act(`(() => { const el = $$('.ms-option').find((x) => txt(x.querySelector('.ms-option__label')) === '北京').querySelector('input'); el.click(); })()`, 400);
    check('R10-30 取消勾北京→只剩上海', sh, await read(`rows().length`));
    await act(`setVal($$('.filters select')[0], 'chatting')`, 400);
    const expectCombo = await read(`(() => {
      const db = dbNow();
      return db.applications.filter((a) => ((a.city || '').trim() === '上海') && a.status === 'chatting').length;
    })()`);
    const combo = await read(`({ n: rows().length, statuses: [...new Set(rows().map((r) => txt(r.querySelector('.table__status'))))] })`);
    check('R10-31 城市+状态组合筛选行数', expectCombo, combo.n);
    check(
      'R10-32 组合筛选后状态单一且正确',
      true,
      combo.statuses.length <= 1 && (combo.n === 0 || combo.statuses[0] === '已沟通'),
    );
    await act(`clickText('.filters .btn', '清除筛选')`, 420);
    check('R10-33 清除筛选：城市与状态一起归零', { trigger: '全部城市', n: 9 }, await read(`({ trigger: triggerText(), n: rows().length })`));

    /* ============== 轮次 chip 高亮语义（工程师 Round 3 补的那一刀） */
    log('轮次 chip 高亮：未记不高亮、显式点选才高亮');
    await act(`(() => {
      const row = rows().find((r) => txt(r.cells[0]).indexOf(${JSON.stringify(target.company)}) >= 0);
      row.click();
    })()`, 420);
    const activeChip = await read(`({ n: $$('.reject-block .chip-toggle.is-active').length, text: $$('.reject-block .chip-toggle.is-active').map((el) => txt(el)) })`);
    check('R6-22 已记 HR 面时仅该 chip 高亮', { n: 1, text: ['HR 面'] }, activeChip);
    await esc();

    await act(`(() => {
      const row = rows().find((r) => txt(r.cells[0]).indexOf('测试公司-空城') >= 0);
      row.click();
    })()`, 420);
    await act(`clickText('.drawer__actions .btn', '标为已挂')`, 420);
    check('R6-23 快选区初始无 chip 高亮', 0, await read(`$$('.reject-picker .chip-toggle.is-active').length`));
    await act(`clickText('.reject-picker .chip-toggle', '不记得了')`, 400);
    const unknown = await read(`({ active: $$('.reject-picker .chip-toggle.is-active').map((el) => txt(el)), round: (() => {
      const db = dbNow();
      const c = db.companies.find((x) => x.name === '测试公司-空城');
      return db.applications.filter((x) => x.companyId === c.id).pop().rejectedAtRound ?? null;
    })(), hint: txt($('.reject-picker__hint')) })`);
    check('R6-24 显式点「不记得了」→ 落库 null 且该 chip 高亮', { active: ['不记得了'], round: null }, { active: unknown.active, round: unknown.round });
    check('R6-25 hint 文案为「轮次未记」', true, unknown.hint.indexOf('轮次未记') >= 0);
    await esc();

    /* ============================================ 375px 不横向溢出 */
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 780, deviceScaleFactor: 2, mobile: true });
    await sleep(500);
    const narrow = await read(`({ scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth, wrapScroll: $('.table-wrap').scrollWidth > $('.table-wrap').clientWidth })`);
    check('S375-1 375px 不横向溢出', true, narrow.scrollW <= narrow.clientW + 1);
    check('S375-2 窄屏表格内部滚动', true, narrow.wrapScroll);
    await cdp.shot('r3-06-375-list.png');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    /* ============================================ 刷新后数据仍在 */
    await goto(`http://127.0.0.1:${PORT}/`);
    check('S-1 刷新后 9 条仍在', 9, await read(`dbNow().applications.length`));
    check('S-2 刷新后轮次仍是 4', 4, await read(`(() => {
      const db = dbNow();
      const c = db.companies.find((x) => x.name === ${JSON.stringify(target.company)});
      return db.applications.filter((x) => x.companyId === c.id).pop().rejectedAtRound;
    })()`));
  } finally {
    try {
      await cdp.send('Browser.close');
    } catch {
      /* ignore */
    }
    try {
      cdp.ws.close();
    } catch {
      /* ignore */
    }
    await sleep(400);
    client.edge.kill('SIGKILL');
    server.close();
    try {
      fs.rmSync(client.udd, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== Round 3 定点复验: ${pass} PASS / ${fail} FAIL / 共 ${results.length} ===`);
  if (fail > 0) {
    console.log('--- 失败明细 ---');
    for (const r of results.filter((x) => !x.pass)) {
      console.log(`${r.name}\n  期望 ${JSON.stringify(r.expected)} / 实际 ${JSON.stringify(r.actual)}`);
    }
  }
  fs.writeFileSync(
    path.resolve('qa-run/r3-result.json'),
    JSON.stringify({ pass, fail, results }, null, 2),
  );
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('脚本崩溃:', err);
  process.exit(2);
});
