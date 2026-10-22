/**
 * 简历模块的产物级端到端门禁（v0.9 / T05-T06）。
 *
 * 为什么要有它：`src` 里没有任何测试挂载 `App`（组件测试都从子组件切入），
 * 所以「按 6 进简历页」「新建 → 三栏」「存版本 → ⌘Z → ⌘Y」「绑定 → 改绑 →
 * 悬空显示」「打印出纸」这条**真实用户路径**只有类型检查兜着 —— 类型过 ≠ 真能点。
 * 这里用 CDP 直连 headless Edge，在**真实的 dist/index.html** 上点一遍。
 *
 * 与 check:print 的分工：
 * - check:print 验「纸」—— 布局、分页、出纸（借 harness 逐模板驱动）；
 * - 本门禁验「流程」—— 简历页与投递绑定的产品路径，全程真实产物、真实 localStorage。
 *
 * ★ 不接进 `npm run verify`：需要本机 Edge（与 check:print 同待遇）。
 *   前置：`npm run build`。
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findEdge, openPage, sleep, waitFor } from './lib/cdp.mjs';

const APP = dirname(fileURLToPath(import.meta.url));
const DIST = join(APP, '..', 'dist', 'index.html');
const url = `file:///${DIST.replace(/\\/g, '/')}`;

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  →  ${detail}` : ''}`);
}

const edge = findEdge();
if (!edge) {
  console.error('✗ 找不到 Edge（可用 JOB_DESK_EDGE 指定 msedge 路径）');
  process.exit(1);
}
if (!existsSync(DIST)) {
  console.error('✗ 找不到 dist/index.html，先运行 npm run build');
  process.exit(1);
}

const profileDir = mkdtempSync(join(tmpdir(), 'jobdesk-resume-'));
const page = await openPage({ edge, profileDir });

/** 受控 input 的通用写法：走原生 setter 再派发 input 事件（React 受控组件才认） */
const SET_VALUE = `
window.__setValue = (el, value) => {
  const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
};
window.__clickText = (selector, text) => {
  const btn = [...document.querySelectorAll(selector)].find((b) => b.textContent.includes(text));
  if (btn) btn.click();
  return !!btn;
};
window.__db = () => JSON.parse(localStorage.getItem('jobdesk.v1') || '{}');`;

try {
  await page.page.send('Page.enable');
  await page.page.send('Runtime.enable');
  await page.page.send('Page.navigate', { url });
  await sleep(1500);
  await page.page.eval(SET_VALUE);

  // 空库先落在欢迎页（挡住整个外壳），点主按钮进主界面
  await page.page.eval(`window.__clickText('button', '加载示例数据')`);
  await sleep(600);

  /* ---------------- A. 导航与热键 ---------------- */

  const navInfo = await page.page.eval(`(() => {
    const items = [...document.querySelectorAll('.nav .nav__item')];
    return { count: items.length, labels: items.map((b) => b.textContent.trim()) };
  })()`);
  check('导航项 = 6（第 6 项由 VIEWS 自动生成）', navInfo.count === 6, navInfo.labels.join(' / '));

  await page.page.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '6' }))`);
  await waitFor(page.page, `!!document.querySelector('.resume-home')`, { label: '按 6 进简历页' });
  const home = await page.page.eval(`(() => ({
    title: document.querySelector('.resume-home__title')?.textContent || '',
    active: document.querySelector('.nav__item.is-active')?.textContent.trim() || '',
  }))()`);
  check('按 6 切到简历页且高亮跟着走', home.title === '简历' && home.active === '简历', `title=${home.title} active=${home.active}`);

  /* ---------------- B. 建简历 → 存版本 → 撤销 ---------------- */

  await page.page.eval(`window.__clickText('.resume-home button', '新建简历')`);
  await waitFor(page.page, `!!document.querySelector('input[aria-label="简历名字"]')`, { label: '新建面板展开' });
  await page.page.eval(`window.__setValue(document.querySelector('input[aria-label="简历名字"]'), '端到端简历')`);
  await page.page.eval(`window.__clickText('.resume-home__new-acts button', '创建')`);
  await waitFor(page.page, `!!document.querySelector('.resume-editor__panes')`, { label: '进入编辑态' });

  const panes = await page.page.eval(`(() => ({
    tpl: document.querySelectorAll('.tpl-card').length,
    form: document.querySelectorAll('.resume-form').length,
    a4: document.querySelectorAll('.a4__body').length,
    ver: document.querySelectorAll('.ver-menu').length,
    print: document.querySelectorAll('.print-entry button').length,
  }))()`);
  check('编辑态三栏都在（模板 / 表单 / A4）+ 版本菜单 + 打印入口', panes.tpl === 8 && panes.form === 1 && panes.a4 === 1 && panes.ver === 1 && panes.print === 1, JSON.stringify(panes));

  // 400 ms 防抖落库：改一个字段，等 700 ms，看 localStorage
  await page.page.eval(`(() => {
    const input = document.querySelector('.resume-form input.input');
    input.focus();
    window.__setValue(input, '林一舟');
  })()`);
  await sleep(700);
  const persisted = await page.page.eval(`(() => {
    const resume = window.__db().resumes.find((item) => item.name === '端到端简历');
    return { hit: !!resume, text: JSON.stringify(resume?.content || {}).includes('林一舟') };
  })()`);
  check('防抖到点草稿真落库（不点保存也不丢）', persisted.hit && persisted.text, JSON.stringify(persisted));

  await page.page.eval(`window.__setValue(document.querySelector('input[aria-label="新版本名"]'), '投递版A')`);
  await page.page.eval(`window.__clickText('.ver-menu__save button', '存为新版本')`);
  await sleep(300);
  let verCount = await page.page.eval(`document.querySelectorAll('.ver-list .ver-item').length`);
  check('存为新版本 → 版本列表 1 条', verCount === 1, `条数=${verCount}`);

  await page.page.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))`);
  await sleep(300);
  verCount = await page.page.eval(`document.querySelectorAll('.ver-list .ver-item').length`);
  check('⌘Z 一步撤掉存版本', verCount === 0, `条数=${verCount}`);
  const stillTyped = await page.page.eval(`(() => {
    const resume = window.__db().resumes.find((item) => item.name === '端到端简历');
    return JSON.stringify(resume?.content || {}).includes('林一舟');
  })()`);
  check('撤版本操作不连带回滚草稿（切片撤销）', stillTyped === true, `内容仍在=${stillTyped}`);
  await page.page.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }))`);
  await sleep(300);
  verCount = await page.page.eval(`document.querySelectorAll('.ver-list .ver-item').length`);
  check('⌘Y 重做回来', verCount === 1, `条数=${verCount}`);

  /* ---------------- C. 绑定：真实投递 × 真实版本 ---------------- */

  await page.page.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '3' }))`);
  await waitFor(page.page, `!!document.querySelector('.table tbody tr')`, { label: '列表就绪' });
  // 记下所有投递的活跃度基准：绑定后逐一比对，谁都不能被改
  const activityBefore = await page.page.eval(`(() => {
    const map = {};
    for (const app of window.__db().applications) map[app.id] = app.lastActivityAt;
    return map;
  })()`);
  await page.page.eval(`document.querySelector('.table tbody tr').click()`);
  await waitFor(page.page, `!!document.querySelector('select[aria-label="绑定的简历版本"]')`, { label: '抽屉里出现绑定选择器' });

  const bindState = await page.page.eval(`(() => {
    const select = document.querySelector('select[aria-label="绑定的简历版本"]');
    const options = [...select.querySelectorAll('option')];
    return {
      count: options.length,
      versionOption: options.find((o) => o.value.startsWith('ver_'))?.value || '',
      hasDraftOption: options.some((o) => o.value === 'draft'),
      label: options.find((o) => o.selected)?.textContent || '',
    };
  })()`);
  check('候选只有冻结版本，没有「草稿」这一项', bindState.count >= 2 && bindState.versionOption !== '' && !bindState.hasDraftOption, JSON.stringify(bindState));

  await page.page.eval(`window.__setValue(document.querySelector('select[aria-label="绑定的简历版本"]'), '${bindState.versionOption}')`);
  await sleep(500);
  const afterBind = await page.page.eval(`(() => {
    const app = window.__db().applications.find((item) => item.resumeVersionId);
    return {
      bound: !!app,
      versionId: app?.resumeVersionId || '',
      snapshot: app?.resumeVersion || '',
      log: app?.resumeBindLog?.length ?? 0,
    };
  })()`);
  check('绑定写进库：id + 当时快照名 + 留痕 1 条', afterBind.bound && afterBind.versionId === bindState.versionOption && afterBind.snapshot !== '' && afterBind.log === 1, JSON.stringify(afterBind));

  const f9 = await page.page.eval(`(() => {
    const before = ${JSON.stringify(activityBefore)};
    return window.__db().applications.every((app) => app.lastActivityAt === before[app.id]);
  })()`);
  check('★ F9：改绑没有改任何一条投递的 lastActivityAt', f9 === true, `全部一致=${f9}`);
  const noteCount = await page.page.eval(`window.__db().notes.filter((n) => (n.content || '').includes('简历版本') || (n.content || '').includes('绑定')).length`);
  check('★ F9：时间线里没有因为改绑而多出来的记录', noteCount === 0, `命中=${noteCount}`);
  const logVisible = await page.page.eval(`!!document.querySelector('.bind__log') && document.querySelector('.bind__log summary').textContent.includes('改绑记录（1）')`);
  check('改绑留痕就摆在字段旁边（改绑记录（1））', logVisible === true);

  /* ---------------- D. 删版本 → 悬空显示 ---------------- */

  // 抽屉开着时快捷键被 overlayOpen 挡住（设计如此），先用 Esc 关掉抽屉
  await page.page.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(300);
  await page.page.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '6' }))`);
  await waitFor(page.page, `!!document.querySelector('.ver-menu')`, { label: '回到编辑态' });
  await page.page.eval(`window.__clickText('.ver-item button', '删除')`);
  await sleep(200);
  const confirmText = await page.page.eval(`document.querySelector('.ver-item__confirm')?.textContent || ''`);
  check('删除确认把「投递记录会保留」放在第一句（A-12）', confirmText.includes('投递记录会保留'), confirmText.slice(0, 60));
  check('删除确认报出了被引用的投递数', confirmText.includes('1 条投递'), confirmText.slice(0, 90));
  await page.page.eval(`window.__clickText('.ver-item__confirm button', '确认删除')`);
  await sleep(300);
  verCount = await page.page.eval(`document.querySelectorAll('.ver-list .ver-item').length`);
  check('确认删除 → 版本列表清空（进回收站）', verCount === 0, `条数=${verCount}`);

  await page.page.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '3' }))`);
  await waitFor(page.page, `!!document.querySelector('.table tbody tr')`, { label: '回列表' });
  await page.page.eval(`document.querySelector('.table tbody tr').click()`);
  await waitFor(page.page, `!!document.querySelector('select[aria-label="绑定的简历版本"]')`, { label: '重新打开抽屉' });
  const dangling = await page.page.eval(`(() => {
    const select = document.querySelector('select[aria-label="绑定的简历版本"]');
    const disabled = [...select.querySelectorAll('option')].find((o) => o.disabled);
    return {
      text: disabled?.textContent || '',
      cls: select.className.includes('bind__select--dangling'),
      hint: document.querySelector('.bind__hint')?.textContent || '',
    };
  })()`);
  check('★ 版本删除后：下拉保留 disabled 的「投递版A（已删除）」', dangling.text.includes('（已删除）') && dangling.text.includes('（当前，已删除）'), JSON.stringify(dangling));
  check('★ 悬空态有说明文案（投递记录保留）', dangling.hint.includes('投递记录保留'), dangling.hint);

  /* ---------------- E. 打印链路 + 刷新 ---------------- */

  // 打印入口在编辑态：关掉抽屉回编辑器
  await page.page.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(300);
  await page.page.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '6' }))`);
  await waitFor(page.page, `!!document.querySelector('.print-entry button')`, { label: '回到编辑态' });
  await page.page.eval(`window.__printed = 0; window.print = () => { window.__printed += 1; };`);
  await page.page.eval(`document.querySelector('.print-entry button').click()`);
  await waitFor(page.page, `!!document.querySelector('.print-hint')`, { label: '打印提示层出现' });
  await page.page.eval(`window.__clickText('.print-hint__acts button', '继续打印')`);
  await sleep(400);
  const printState = await page.page.eval(`({ printed: window.__printed, printing: String(document.body.dataset.printing ?? 'none') })`);
  check('打印链路通：继续打印真的调用了 window.print', printState.printed === 1, JSON.stringify(printState));
  check('打印结束后 data-printing 已摘掉', printState.printing === 'none', `data-printing=${printState.printing}`);

  await page.page.send('Page.reload', { ignoreCache: false });
  await sleep(1500);
  await page.page.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '6' }))`);
  await waitFor(page.page, `!!document.querySelector('.resume-home')`, { label: '刷新后回简历页' });
  const afterReload = await page.page.eval(`(() => ({
    list: !!document.querySelector('.resume-home'),
    editor: !!document.querySelector('.resume-editor'),
    rows: document.querySelectorAll('.resume-row').length,
  }))()`);
  check('刷新后回列表态而不是编辑态（打开的是 UI 状态，不落库）', afterReload.list && !afterReload.editor, JSON.stringify(afterReload));
  check('刷新后简历还在', afterReload.rows >= 1, `行数=${afterReload.rows}`);

  console.log(`\n断言 ${failed === 0 ? '全部通过' : `失败 ${failed} 条`}`);
} finally {
  page.close();
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* Edge 还没退干净时 Windows 会锁 profile，无所谓 */
  }
}
process.exit(failed === 0 ? 0 : 1);
