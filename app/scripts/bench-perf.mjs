/**
 * v0.5 / D6 性能基准：在**真实产物**上量「数据量 → 交互延迟」的关系。
 *
 * 为什么不用 jsdom 跑 benchmark：jsdom 没有布局、没有合成层，
 * 量出来的数字与用户体感无关；而本项目最贵的操作（表格重排、列表滚动）
 * 恰恰依赖真实布局。
 *
 * 做法：CDP 驱动 Edge headless，往 localStorage 里灌 N 条投递，
 * 再注入一段测量脚本，跑三组指标：
 *   1. 首屏可交互时间（数据已就绪 → 表格/看板出现）
 *   2. 列表视图切换耗时
 *   3. 200 条时筛选/排序函数耗时，1000 条时窗口化后的行数
 *   4. 看板窗口化自证：切到看板后**实际渲染的卡片数**（`renderedCards`）
 *
 * ## 为什么要有第 4 项（v0.9.1 / B-11）
 *
 * 「看板降到 X ms」这句话没法自证 —— 把卡片全删了也很快。真正证明窗口生效的是
 * 「1000 条数据下，看板 DOM 里的 `.app-card` 不超过 列数 × 窗口(40)」。
 * 但这句上界**在小样本上不灵敏**（QA v0.9.1 指出：200 条那组只渲染 167 张，
 * 窗口彻底失效也小于 320，照样过门禁），所以真正的判据是**逐列核对规则本身**：
 * 某列「已渲染 === min(总数, 40)」，其中总数 = 已渲染 + 按钮上的「还有 N 家」。
 * 四条判据（上界 / 逐列规则 / 全局对账 / 大样本必截断）任一不成立就退出码 1，
 * 免得性能报告变成好看的空话。
 *
 * 用法：node scripts/bench-perf.mjs
 * 前置：npm run build（需要 dist/index.html）
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { findEdge, sleep, openPage } from './lib/cdp.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(APP_DIR, 'dist', 'index.html');
const OUT_DIR = join(APP_DIR, 'bench-out');

const SIZES = [50, 200, 500, 1000];

/**
 * 看板 DOM 卡片上限 = 列数 × 窗口(40)。
 * 7 个主列 + 1 个「已结束」列 = 8 列 → 320。与 `src/lib/boardWindow.ts` 的
 * `BOARD_WINDOW`/`maxRenderedCards` 同口径（脚本不能 import TS，故此处硬写并在这条注释里对齐）。
 */
const BOARD_COLUMNS = 8;
const BOARD_WINDOW = 40;
const MAX_BOARD_CARDS = BOARD_COLUMNS * BOARD_WINDOW;

if (!existsSync(DIST)) {
  console.error('✗ 找不到 dist/index.html，先运行 npm run build');
  process.exit(1);
}

const edge = findEdge();
if (!edge) {
  console.error('✗ 找不到 Edge，无法跑基准（可用 JOB_DESK_EDGE 指定路径）');
  process.exit(1);
}

/** 造一个 N 条投递的库（结构与真实数据一致，避免「测了个假库」） */
function buildSeed(n) {
  const now = Date.now();
  const statuses = ['wishlist', 'applied', 'chatting', 'interviewing', 'offer', 'rejected'];
  const channels = ['referral', 'official', 'boss', 'shixiseng', 'other'];
  const companies = [];
  const applications = [];
  const interviews = [];
  const notes = [];

  for (let i = 0; i < n; i += 1) {
    const companyId = `c${i}`;
    companies.push({
      id: companyId,
      name: `压测公司${i}`,
      shortName: `压测${i}`,
      createdAt: new Date(now - i * 86400000).toISOString(),
    });
    const appId = `a${i}`;
    const appliedAt = new Date(now - (i % 120) * 86400000).toISOString();
    applications.push({
      id: appId,
      companyId,
      jobTitle: `后端开发实习生 ${i}`,
      city: ['北京', '上海', '深圳', '杭州'][i % 4],
      channel: channels[i % channels.length],
      status: statuses[i % statuses.length],
      appliedAt,
      resumeVersion: `v${(i % 5) + 1}`,
      priority: (i % 3) + 1,
      jdUrl: '',
      salaryText: '',
    });
    // 每 3 条造一场面试，让「下一次动作」列有内容
    if (i % 3 === 0) {
      interviews.push({
        id: `iv${i}`,
        applicationId: appId,
        round: 1,
        scheduledAt: new Date(now + ((i % 14) + 1) * 86400000).toISOString(),
        format: 'video',
        result: 'pending',
      });
    }
    // 每 2 条造一条沟通记录（沉默天数计算依赖它）
    if (i % 2 === 0) {
      notes.push({
        id: `n${i}`,
        applicationId: appId,
        type: 'memo',
        content: `第 ${i} 条沟通记录`,
        touchedAt: appliedAt,
      });
    }
  }

  return {
    schemaVersion: 2,
    companies,
    applications,
    interviews,
    notes,
    experiences: [],
    questions: [],
    staging: [],
    events: [],
    settings: {},
  };
}

/* ------------------------------------------------------------------ 主流程 */

const results = [];

for (const size of SIZES) {
  const profileDir = join(tmpdir(), `jobdesk-bench-${size}-${Date.now()}`);
  process.stdout.write(`跑 ${size} 条… `);
  const page = await openPage({ edge, profileDir });
  try {
    await page.page.send('Page.enable');
    await page.page.send('Runtime.enable');

    // 先打开页面（拿到 origin），再灌数据，再重载 —— 这样测的是真实的
    // 「带着 N 条数据启动」路径，而不是「空库启动后再塞数据」
    const fileUrl = `file:///${DIST.replace(/\\/g, '/')}`;
    await page.page.send('Page.navigate', { url: fileUrl });
    await sleep(1200);

    const seed = buildSeed(size);
    await page.page.eval(`localStorage.setItem('jobdesk.v1', ${JSON.stringify(JSON.stringify(seed))})`);
    // 记住「上次看到的视图 = 列表」，否则首屏落在今日视图，量不到表格
    await page.page.eval(
      `localStorage.setItem('jobdesk.v1.ui', ${JSON.stringify(JSON.stringify({ view: 'list', insightsTab: 'data' }))})`,
    );

    // 关键：用 CDP 的 Page.reload 而不是 eval('location.reload()') ——
    // 后者会打断执行上下文，Promise 永远不 settle，后续 eval 全部超时
    const reloadAt = Date.now();
    await page.page.send('Page.reload', { ignoreCache: false });
    await sleep(2500);

    const metrics = await page.page.eval(`(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const rows = document.querySelectorAll('.table tbody tr:not(.table__spacer)').length;
      const paint = performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint');
      return {
        domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        loadComplete: nav ? Math.round(nav.loadEventEnd) : null,
        firstPaint: paint ? Math.round(paint.startTime) : null,
        renderedRows: rows,
        memoryMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      };
    })()`);
    metrics.wallMs = Date.now() - reloadAt;

    // 列表排序/筛选一次要多久：直接量「点一下表头到 DOM 更新完」
    const interaction = await page.page.eval(`(async () => {
      const th = document.querySelectorAll('.table thead th')[0];
      if (!th) return null;
      const t0 = performance.now();
      th.click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return Math.round((performance.now() - t0) * 10) / 10;
    })()`);


    const diag = await page.page.eval(`(async () => {
      const keys = Object.keys(localStorage);
      const main = localStorage.getItem('jobdesk.v1') || '';
      return {
        keys,
        mainLen: main.length,
        tableRows: document.querySelectorAll('.table tbody tr').length,
        failedPage: document.body.innerText.includes('数据读取失败'),
        bodyHead: document.body.innerText.slice(0, 80).replace(/\\n/g, '|'),
      };
    })()`);
    // 自检：如果落进了失败页，这组数字毫无意义 —— 直接标错，
    // 免得表格里出现一排漂亮的假数据（写这个脚本时就踩过一次）
    if (diag.failedPage || diag.tableRows === 0) {
      throw new Error(`数据没进界面：${diag.bodyHead}`);
    }

    // v0.8 / T05 验收 15：今日待办与看板切换耗时（点一级 tab → 两次 rAF 后的稳定帧）。
    // 看板是 v0.8 改版重点（7 列 + 轮次徽章），必须单独量，不能只看列表排序。
    // ★ 放在自检之后：这个测量会把视图切走，先自检才不会被自己坑成「数据没进界面」。
    const viewSwitch = await page.page.eval(`(async () => {
      const clickView = async (label) => {
        const button = [...document.querySelectorAll('button')].find((item) =>
          (item.textContent || '').trim().startsWith(label),
        );
        if (!button) return null;
        const t0 = performance.now();
        button.click();
        // 离散事件里 React 会同步 flush：click 返回时 render+commit 已完成
        const sync = Math.round((performance.now() - t0) * 10) / 10;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return { sync, frame: Math.round((performance.now() - t0) * 10) / 10 };
      };
      const board = await clickView('看板');
      // 切到看板之后再数卡片（顺序错了数到的就是列表的 0 张）
      const cards = document.querySelectorAll('.app-card').length;
      const more = document.querySelectorAll('.board__more').length;
      // ★ 逐列量「已渲染 / 未渲染」：只看全局总数是**不敏感**的 ——
      //   200 条那组本来就只有 167 张卡（< 320 上限），窗口彻底失效也照样过。
      //   逐列拿到 cards + hidden 就能算出该列真实总数，再对 min(total, 40) 逐条核对，
      //   这才是「窗口规则」本身，而不是「数字没超上限」这种偶然成立的上界。
      //   折叠列（面试段折叠 / 「已结束」未展开）不渲染 body，不参与核对。
      const columns = [...document.querySelectorAll('.board__col')]
        .filter((col) => col.querySelector('.board__col-body'))
        .map((col) => {
          const rendered = col.querySelectorAll('.app-card').length;
          const moreEl = col.querySelector('.board__more');
          const hidden = moreEl ? Number((moreEl.textContent || '').match(/(\\d+)/)?.[1] || 0) : 0;
          return { rendered, hidden, total: rendered + hidden };
        });
      return { today: await clickView('今日'), board, cards, more, columns };
    })()`);

    results.push({
      size,
      ...metrics,
      interactionMs: interaction,
      todayMs: viewSwitch.today?.frame ?? null,
      boardMs: viewSwitch.board?.frame ?? null,
      boardRenderMs: viewSwitch.board?.sync ?? null,
      /** v0.9.1 / B-11：看板实际渲染的卡片数（窗口自证） */
      renderedCards: viewSwitch.cards ?? null,
      /** 有多少列出现了「还有 N 家」（窗口真的截断过） */
      windowedColumns: viewSwitch.more ?? null,
      /** 逐列明细：`rendered` 渲染了几张、`hidden` 按钮上写着还有几家 */
      columns: viewSwitch.columns ?? [],
    });
    console.log('ok');
  } catch (error) {
    console.log(`失败：${error.message}`);
    results.push({ size, error: error.message });
  } finally {
    page.close();
  }
}

/* ------------------------------------------------------------------ 输出 */

mkdirSync(OUT_DIR, { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  note: 'headless Edge，file:// 协议，localStorage 后端；数字是「本机相对比较」用的，不是绝对承诺',
  results,
};
writeFileSync(join(OUT_DIR, 'perf.json'), `${JSON.stringify(report, null, 2)}\n`);

console.log('');
console.log(
  '条数   首屏(ms)   可交互(ms)   渲染行数   堆内存(MB)   排序一次(ms)   今日(ms)   看板(ms)   看板render(ms)   看板卡片   截断列',
);
for (const row of results) {
  if (row.error) {
    console.log(`${String(row.size).padStart(4)}   ${row.error}`);
    continue;
  }
  console.log(
    `${String(row.size).padStart(4)}   ${String(row.firstPaint ?? '—').padStart(8)}   ${String(
      row.domContentLoaded ?? '—',
    ).padStart(10)}   ${String(row.renderedRows).padStart(8)}   ${String(row.memoryMB ?? '—').padStart(10)}   ${String(
      row.interactionMs ?? '—',
    ).padStart(11)}   ${String(row.todayMs ?? '—').padStart(8)}   ${String(row.boardMs ?? '—').padStart(
      8,
    )}   ${String(row.boardRenderMs ?? '—').padStart(15)}   ${String(row.renderedCards ?? '—').padStart(
      8,
    )}   ${String(row.windowedColumns ?? '—').padStart(6)}`,
  );
}

/* ------------------------------------------------- 硬门禁：窗口真的生效了吗 */
//
// 只看耗时是没法证伪的（少了卡片当然快）。这里断言四类**可验证的事实**：
//
//   ① 上界：全局渲染卡片数 ≤ 列数 × 40（窗口彻底失效时会变成条数，立刻红）；
//   ② **规则本身（逐列）**：某列真实总数 = 已渲染 + 按钮上的「还有 N 家」，
//      则「已渲染」必须恰好等于 `min(总数, 40)`。这是窗口的**定义式**，
//      而不是它的一个副产品 —— QA 指出的正是「只写上界不灵敏」：
//      200 条那组总共才 167 张卡，就算窗口完全失效（167 张全渲染）也小于 320 的上界，
//      ① 照样过。② 则要求「60 张的列不能渲染 60 张」，与样本大小无关；
//   ③ 一致性：全局卡片数 === 逐列已渲染之和（防止卡片挂到列外、或漏数整列）；
//   ④ 灵敏度护栏：数据量 ≥ 500 时**必须**至少有一列被截断。
//      没有它，②③ 在「所有列都没满 40 张」时也会自动成立（此时窗口根本没被考验到），
//      于是门禁会悄悄退化成一句空话。
const overCap = results.filter((row) => !row.error && (row.renderedCards ?? 0) > MAX_BOARD_CARDS);

/** ② 逐列核对 `rendered === min(total, 40)` */
const badColumns = [];
/** ③ 全局数与逐列和的对账 */
const sumMismatch = [];
for (const row of results) {
  if (row.error) continue;
  const columns = row.columns ?? [];
  for (const [index, col] of columns.entries()) {
    const expected = Math.min(col.total, BOARD_WINDOW);
    if (col.rendered !== expected) badColumns.push({ size: row.size, index, ...col, expected });
  }
  const sum = columns.reduce((acc, col) => acc + col.rendered, 0);
  if ((row.renderedCards ?? 0) !== sum) {
    sumMismatch.push({ size: row.size, renderedCards: row.renderedCards ?? 0, sum });
  }
}
/** ④ 大样本必须真的截断过 */
const notTruncated = results.filter(
  (row) => !row.error && row.size >= 500 && (row.windowedColumns ?? 0) === 0,
);

if (overCap.length > 0) {
  console.error('');
  console.error(`✗ 看板窗口没生效：${overCap.length} 组数据的渲染卡片数超过 ${MAX_BOARD_CARDS}`);
  for (const row of overCap) console.error(`    ${row.size} 条 → 渲染 ${row.renderedCards} 张卡`);
  process.exitCode = 1;
}
if (badColumns.length > 0) {
  console.error('');
  console.error('✗ 某列的渲染数 ≠ min(该列总数, 窗口 40) —— 窗口规则没有真正生效');
  for (const col of badColumns) {
    console.error(
      `    ${col.size} 条 · 第 ${col.index + 1} 列 → 总数 ${col.total}（渲染 ${col.rendered} + 还有 ${col.hidden}），` +
        `应渲染 ${col.expected} 张，实际 ${col.rendered} 张`,
    );
  }
  process.exitCode = 1;
}
if (sumMismatch.length > 0) {
  console.error('');
  console.error('✗ 全局卡片数与「逐列已经渲染之和」对不上（有卡片挂到了列外，或漏数了整列）');
  for (const row of sumMismatch) {
    console.error(`    ${row.size} 条 → 全局 ${row.renderedCards} 张，逐列相加 ${row.sum} 张`);
  }
  process.exitCode = 1;
}
if (notTruncated.length > 0) {
  console.error('');
  console.error('✗ 数据量 ≥ 500 时没有任何一列被截断 —— 窗口形同虚设（门禁失去灵敏度）');
  for (const row of notTruncated) console.error(`    ${row.size} 条 → 截断列 0`);
  process.exitCode = 1;
}
if (process.exitCode !== 1) {
  const checked = results.filter((row) => !row.error).length;
  const truncated = results.filter((row) => !row.error && (row.windowedColumns ?? 0) > 0).length;
  const columnCount = results.reduce((acc, row) => acc + (row.columns?.length ?? 0), 0);
  console.log(
    `✓ 看板窗口自证：${checked} 组数据、${columnCount} 个非折叠列逐个核对「已渲染 === min(总数, ${BOARD_WINDOW})」全部成立；` +
      `全局渲染数均 ≤ ${MAX_BOARD_CARDS}（列数 ${BOARD_COLUMNS} × 窗口 ${BOARD_WINDOW}）；` +
      `${truncated} 组确有列被截断；≥500 条的组都至少截断 1 列`,
  );
}
console.log('');
console.log(`明细已写入 ${join(OUT_DIR, 'perf.json')}`);
