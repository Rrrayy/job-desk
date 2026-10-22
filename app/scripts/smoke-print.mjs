/**
 * 打印门禁（ARCH §6.2 的 L2 + L3）—— `node scripts/smoke-print.mjs`
 *
 * 为什么需要真浏览器：`@media print` 的每一条规则都只在**打印媒体**下成立，
 * jsdom 不评估媒体查询（L1 只能证明编排顺序，证明不了 CSS 生效）。
 * 而这类 bug 的形态恰好是「代码看起来全对、打印出来一塌糊涂」：
 * `!important` 被后面的规则盖掉、选择器拼错一个字母、`@page` 被 minify 掉。
 *
 * 三个领域，各测各能测的：
 *   L2（真布局）  ：切到打印媒体后逐条量 computed style，确认「装饰消失、分页保护生效」
 *   L2（零网络）  ：订阅 `Network.requestWillBeSent`，确认整页只加载 file:/data:
 *   L3（能出纸）  ：`Page.printToPDF` 产出**非空字节（> 1 KB）即过**
 *
 * ★ L3 **不解析 PDF 内容**（A-02 教训）：Chrome 用 `/ObjStm` 压缩对象流，
 *   正则数 `/Type /Page` 会静默返回 0 —— 一个「永远通过」的假断言比没有断言更坏。
 *   页数真相由 L2 的 `data-pages`（预览的同一把尺子）+ 逐元素 computed style 承担。
 *
 * 被测页面两处，各司其职：
 *   ① `dist/index.html`（真实产物）：`@page` 全仓唯一、CSS 里确实带了打印规则、零外部请求
 *   ② `scripts/print-harness/harness.tsx`（esbuild 现场打）：真组件 + 真样式，
 *      因为 T03 时点 `A4Preview` 还没有生产消费方（T05 才挂上去），
 *      真产物里没有 `.a4` 元素 —— 对着不存在的元素断言是最糟的假测试
 *
 * 前置：`npm run build`（需要 dist/index.html）+ 本机有 Edge（或 `JOB_DESK_EDGE`）。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { findEdge, openPage, sleep, waitFor } from './lib/cdp.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(APP_DIR, 'dist', 'index.html');
const HARNESS_ENTRY = join(APP_DIR, 'scripts', 'print-harness', 'harness.tsx');

/* ------------------------------------------------------------------ 断言收集 */

const results = [];
let failed = 0;

/**
 * @param {string} label
 * @param {boolean} ok
 * @param {string} [detail] 断言不过时要能一眼看出「量到了什么」
 */
function check(label, ok, detail = '') {
  results.push({ label, ok, detail });
  if (!ok) failed += 1;
  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${label}${detail ? `  →  ${detail}` : ''}`);
}

/* ------------------------------------------------------------------ 前置检查 */

if (!existsSync(DIST)) {
  console.error('✗ 找不到 dist/index.html，先运行 npm run build');
  process.exit(1);
}

const edge = findEdge();
if (!edge) {
  console.error('✗ 找不到 Edge（可用 JOB_DESK_EDGE 指定 msedge 路径）');
  process.exit(1);
}

/* ------------------------------------------------------------------ ① 打宿主页 */

const WORK = mkdtempSync(join(tmpdir(), 'jobdesk-print-'));
const HARNESS_OUT = join(WORK, 'harness');
mkdirSync(HARNESS_OUT, { recursive: true });

let esbuild;
try {
  // esbuild 随 vite 一起装（vite 的依赖），不需要额外 devDependency
  esbuild = await import('esbuild');
} catch {
  console.error('✗ 找不到 esbuild（应该是 vite 的依赖；先 npm install）');
  process.exit(1);
}

const buildResult = await esbuild.build({
  entryPoints: [HARNESS_ENTRY],
  outdir: HARNESS_OUT,
  bundle: true,
  format: 'iife',
  // 生产模式：避免 dev 版 React 的告警与双份代码影响布局测量
  define: { 'process.env.NODE_ENV': '"production"' },
  target: ['chrome110'],
  logLevel: 'silent',
  metafile: true,
});
if (buildResult.errors.length > 0) {
  for (const error of buildResult.errors) console.error(error.text);
  process.exit(1);
}

const HARNESS_HTML = join(HARNESS_OUT, 'harness.html');
writeFileSync(
  HARNESS_HTML,
  `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="./harness.css" />
    <title>打印门禁宿主页</title>
  </head>
  <body>
    <div id="root"></div>
    <script src="./harness.js"></script>
  </body>
</html>
`,
);

const fileUrl = (path) => `file:///${path.replace(/\\/g, '/')}`;

/* ------------------------------------------------------------------ 会话 */

const profileDir = join(WORK, 'profile');
const session = await openPage({ edge, profileDir });
const { page } = session;

/** 每一页都重新统计请求：'file:' / 'data:' / 'about:' 之外的一条都不许有 */
async function collectRequests() {
  const urls = [];
  // ★ 必须 await：`Network.enable` 还没生效就导航，首批请求会漏记 ——
  // 而「零外部请求」这条断言一旦漏记就会静默通过（最坏的一种通过）
  await page.send('Network.enable');
  const off = page.on('Network.requestWillBeSent', (params) => {
    urls.push(params?.request?.url ?? '');
  });
  return {
    urls,
    stop: () => off(),
    external: () => urls.filter((url) => url && !/^(file|data|blob|about):/i.test(url)),
  };
}

try {
  await page.send('Page.enable');
  await page.send('Runtime.enable');

  /* ================================================================ ① 真实产物 */

  console.log('\n【① 真实产物 dist/index.html】');
  const realRequests = await collectRequests();
  await page.send('Page.navigate', { url: fileUrl(DIST) });
  await waitFor(page, "!!document.querySelector('.topbar, #root > *')", { label: '应用挂载' });
  await sleep(300);

  const cssText = await page.eval(`
    (() => {
      // 单文件产物把 CSS 内联成 <style>：直接读原文最忠实（minify 后的字面量）。
      // ★ 只取一处来源：既读 <style> 又读 cssRules 会把同一份 CSS 数两遍。
      const inline = [...document.querySelectorAll('style')].map((el) => el.textContent || '').join('\\n');
      if (inline.trim()) return inline;
      return [...document.styleSheets]
        .map((sheet) => {
          try { return [...sheet.cssRules].map((rule) => rule.cssText).join('\\n'); } catch { return ''; }
        })
        .join('\\n');
    })()
  `);

  check('产物里的 CSS 取到了（否则后面几条是假通过）', cssText.length > 10000, `${cssText.length} 字符`);
  const pageRules = (cssText.match(/@page\b/g) ?? []).length;
  check('@page 全仓唯一一份（Q4：禁止按模板生成）', pageRules === 1, `出现 ${pageRules} 次`);
  check(
    '@page 是 size:A4 / margin:14mm',
    /@page\s*\{[^}]*margin:\s*14mm[^}]*\}/.test(cssText) && /size:\s*A4/i.test(cssText),
    (cssText.match(/@page\s*\{[^}]*\}/) ?? ['未匹配'])[0].slice(0, 80),
  );
  check('@media print 段进了产物', /@media\s+print\s*\{/.test(cssText));
  check(
    '分页保护进了产物（.rs-item / .rs-section break-inside:avoid）',
    /@media\s+print[\s\S]*break-inside:\s*avoid/.test(cssText) && /@media\s+print[\s\S]*break-after:\s*avoid/.test(cssText),
  );

  const realExternal = realRequests.external();
  realRequests.stop();
  check('真实产物零外部请求', realExternal.length === 0, realExternal.slice(0, 3).join(' | ') || `共 ${realRequests.urls.length} 条，全是本地`);

  /* ================================================================ ② 宿主页 */

  console.log('\n【② 真组件宿主页（screen 媒体，先确认「没打印时该在的东西都在」）】');
  const harnessRequests = await collectRequests();
  await page.send('Page.navigate', { url: fileUrl(HARNESS_HTML) });
  await waitFor(page, "document.documentElement.dataset.harnessReady === '1'", { label: 'harness 渲染完成' });
  await waitFor(page, "!!document.querySelector('.a4 .rs-item')", { label: '.a4 正文出现' });

  const screen = await page.eval(`
    (() => {
      const cs = (sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el) : null;
      };
      const fitEl = document.querySelector('.a4-fit');
      const a4El = document.querySelector('.a4');
      const fit = cs('.a4-fit');
      const a4 = cs('.a4');
      const guide = cs('.a4__guide');
      const pageNo = cs('.a4__page-no');
      const entry = cs('.print-entry');
      return {
        scale: fitEl.style.getPropertyValue('--a4-scale'),
        fitTransform: fit.transform,
        // ★ 布局宽用 computed style（不受祖先 transform 影响）；
        //   getBoundingClientRect 会把祖先 scale 算进去，量「纸上尺寸」必须避开它
        fitLayoutWidth: Number.parseFloat(fit.width),
        a4LayoutWidth: Number.parseFloat(a4.width),
        a4VisualWidth: Math.round(a4El.getBoundingClientRect().width),
        a4BoxShadow: a4.boxShadow,
        guides: document.querySelectorAll('.a4__guide').length,
        pageNos: document.querySelectorAll('.a4__page-no').length,
        guideDisplay: guide ? guide.display : 'no-guide',
        pageNoDisplay: pageNo ? pageNo.display : 'no-guide',
        entryDisplay: entry ? entry.display : 'no-entry',
        bodyHeight: Math.round(document.querySelector('.a4__body').getBoundingClientRect().height),
        pages: fitEl.dataset.pages,
        items: document.querySelectorAll('.rs-item').length,
      };
    })()
  `);

  check(
    '屏幕：外层真有 scale（预览靠这一层缩放，不是改字号）',
    /^matrix\(/.test(screen.fitTransform) && Number(screen.scale) > 0 && Number(screen.scale) <= 1,
    `--a4-scale=${screen.scale} transform=${screen.fitTransform.slice(0, 40)}…`,
  );
  check(
    '屏幕：A4 布局宽 = 210mm 实宽（96dpi 下 ≈ 793.7px）',
    Math.abs(screen.a4LayoutWidth - 793.7) <= 1,
    `${screen.a4LayoutWidth}px`,
  );
  check(
    '屏幕：纸上内容按 scale 缩小（视觉宽 = 实宽 × scale）',
    Math.abs(screen.a4VisualWidth - screen.a4LayoutWidth * Number(screen.scale)) <= 2,
    `视觉 ${screen.a4VisualWidth}px vs ${Math.round(screen.a4LayoutWidth * Number(screen.scale))}px`,
  );
  check('屏幕：纸有阴影（打印时必须消失的那层）', screen.a4BoxShadow !== 'none', screen.a4BoxShadow);
  check('屏幕：分页线/页码在屏幕上可见', screen.guideDisplay === 'inline' || screen.guideDisplay === 'block', `guide=${screen.guideDisplay} pageNo=${screen.pageNoDisplay}`);
  check('屏幕：打印按钮可见（不该被 print 规则误伤）', screen.entryDisplay !== 'none', screen.entryDisplay);
  check('宿主页真的跨页了（否则后面的分页断言没有意义）', Number(screen.pages) >= 2, `data-pages=${screen.pages} bodyH=${screen.bodyHeight}px items=${screen.items}`);

  /* ---------------- 窄窗口：证明「mm 一份真相 + 外层 scale」 ---------------- */

  console.log('\n【②b 窄窗口（520px）：缩放只在外壳，纸上尺寸不许跟着变）】');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 520,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(400);

  const narrow = await page.eval(`
    (() => {
      const fitEl = document.querySelector('.a4-fit');
      const a4El = document.querySelector('.a4');
      return {
        scale: Number(fitEl.style.getPropertyValue('--a4-scale')),
        // 布局宽（computed style，不含祖先 transform）vs 视觉宽（rect，含）
        fitLayoutWidth: Number.parseFloat(getComputedStyle(fitEl).width),
        a4LayoutWidth: Number.parseFloat(getComputedStyle(a4El).width),
        a4VisualWidth: Math.round(a4El.getBoundingClientRect().width),
        fontSize: getComputedStyle(a4El).fontSize,
      };
    })()
  `);

  check('窄窗口下 scale < 1（确实缩了）', narrow.scale > 0 && narrow.scale < 1, `--a4-scale=${narrow.scale}`);
  check(
    '★ A4 布局宽仍是 210mm 实宽（mm 是唯一真相，不随窗口改字号）',
    Math.abs(narrow.a4LayoutWidth - 793.7) <= 1 && narrow.fontSize === '14px',
    `a4=${narrow.a4LayoutWidth}px font-size=${narrow.fontSize}（10.5pt）`,
  );
  check(
    '★ 外壳预留的布局宽 = 实宽 × scale（scale 不改变布局盒，容器必须自己算）',
    Math.abs(narrow.fitLayoutWidth - narrow.a4LayoutWidth * narrow.scale) <= 2,
    `fit=${narrow.fitLayoutWidth} a4×scale=${Math.round(narrow.a4LayoutWidth * narrow.scale)}`,
  );
  check(
    '★ 视觉宽 = 实宽 × scale（缩的是纸，不是纸上的字号）',
    Math.abs(narrow.a4VisualWidth - narrow.a4LayoutWidth * narrow.scale) <= 2,
    `视觉 ${narrow.a4VisualWidth}px`,
  );

  await page.send('Emulation.clearDeviceMetricsOverride');
  await sleep(300);

  /* ---------------- 切到打印媒体 ---------------- */

  console.log('\n【③ 打印媒体（Emulation.setEmulatedMedia: print）】');
  await page.send('Emulation.setEmulatedMedia', { media: 'print' });
  await sleep(200);

  const printed = await page.eval(`
    (() => {
      // 故意把缩放调到 0.5：打印时外壳必须无视它（width:auto !important）。
      // 否则「窗口窄 → 缩放 0.6 → 纸上只剩右半边」这类 bug 会一路溜到用户手里。
      const fitEl = document.querySelector('.a4-fit');
      fitEl.style.setProperty('--a4-scale', '0.5');
      const cs = (sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el) : null;
      };
      const prop = (style, name) => (style ? style.getPropertyValue(name) : null);
      const fit = cs('.a4-fit');
      const a4 = cs('.a4');
      const body = cs('.a4__body');
      const guide = cs('.a4__guide');
      const pageNo = cs('.a4__page-no');
      const item = cs('.rs-item');
      const section = cs('.rs-section');
      const title = cs('.rs-section__title');
      return {
        matchPrint: matchMedia('print').matches,
        fitTransform: fit.transform,
        fitWidthPx: Math.round(document.querySelector('.a4-fit').getBoundingClientRect().width),
        a4WidthPx: Math.round(document.querySelector('.a4').getBoundingClientRect().width),
        a4BoxShadow: a4.boxShadow,
        a4Radius: prop(a4, 'border-radius'),
        bodyPadding: body.padding,
        guideDisplay: guide.display,
        pageNoDisplay: pageNo.display,
        itemBreakInside: prop(item, 'break-inside'),
        itemPageBreakInside: prop(item, 'page-break-inside'),
        sectionBreakInside: prop(section, 'break-inside'),
        titleBreakAfter: prop(title, 'break-after'),
        colorAdjust: prop(a4, 'print-color-adjust') || prop(a4, '-webkit-print-color-adjust'),
      };
    })()
  `);

  check('媒体模拟生效（matchMedia("print") 为真）', printed.matchPrint === true);
  check('★ .a4-fit transform === "none"（缩放壳在纸上必须消失，否则纸被裁）', printed.fitTransform === 'none', printed.fitTransform);
  check(
    '★ .a4-fit 宽度不再受 --a4-scale 影响（宽度与纸同宽）',
    Math.abs(printed.fitWidthPx - printed.a4WidthPx) <= 1 && printed.fitWidthPx > 400,
    `--a4-scale 被钉成 0.5，fit=${printed.fitWidthPx}px a4=${printed.a4WidthPx}px`,
  );
  check('★ .a4 box-shadow === "none"（框是 CSS 画的，不是纸）', printed.a4BoxShadow === 'none', printed.a4BoxShadow);
  check('.a4 圆角清零', printed.a4Radius === '0px', printed.a4Radius);
  check('★ .a4__body padding 为 0（页边距只由 @page 提供，避免双份留白）', printed.bodyPadding === '0px', printed.bodyPadding);
  check('★ 分页辅助线 display:none', printed.guideDisplay === 'none', printed.guideDisplay);
  check('★ 页码 display:none', printed.pageNoDisplay === 'none', printed.pageNoDisplay);
  check('★ .rs-item break-inside:avoid（一条经历不许一半在上一页）', printed.itemBreakInside === 'avoid', printed.itemBreakInside);
  check('★ .rs-item page-break-inside:avoid（旧属性兜底）', printed.itemPageBreakInside === 'avoid', printed.itemPageBreakInside);
  check('.rs-section break-inside:avoid', printed.sectionBreakInside === 'avoid', printed.sectionBreakInside);
  check('★ .rs-section__title break-after:avoid（标题不许孤零零留在页底）', printed.titleBreakAfter === 'avoid', printed.titleBreakAfter);
  check('print-color-adjust:exact（分隔线/色块保真）', printed.colorAdjust === 'exact', printed.colorAdjust);

  /* ---------------- 打印作用域：只摘掉界面壳 ---------------- */

  const scoped = await page.eval(`
    (() => {
      const cs = (sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el) : null;
      };
      const before = {
        entry: cs('.print-entry').display,
        form: cs('.resume__form').display,
        toolbar: cs('.resume__toolbar').display,
      };
      document.body.dataset.printing = '1';
      const during = {
        entry: cs('.print-entry').display,
        form: cs('.resume__form').display,
        toolbar: cs('.resume__toolbar').display,
        a4: cs('.a4').display,
      };
      delete document.body.dataset.printing;
      const after = { entry: cs('.print-entry').display };
      return { before, during, after };
    })()
  `);
  check(
    '★ body[data-printing] 期间：打印按钮/表单/工具条全部 display:none',
    scoped.during.entry === 'none' && scoped.during.form === 'none' && scoped.during.toolbar === 'none',
    `entry=${scoped.during.entry} form=${scoped.during.form} toolbar=${scoped.during.toolbar}`,
  );
  check('★ 简历本体仍可见（只摘壳，不摘内容）', scoped.during.a4 !== 'none', scoped.during.a4);
  check('★ 没有 data-printing 时不隐藏（规则被作用域限定，不是全局摘顶栏）', scoped.after.entry !== 'none', `before=${scoped.before.entry} after=${scoped.after.entry}`);

  const harnessExternal = harnessRequests.external();
  harnessRequests.stop();
  check('宿主页零外部请求', harnessExternal.length === 0, harnessExternal.slice(0, 3).join(' | ') || `共 ${harnessRequests.urls.length} 条，全是本地`);

  /* ================================================================ ④ L3 PDF */

  console.log('\n【④ L3：Page.printToPDF】');
  // 真实流程里这个属性由 printResume 置位（L1 已断言它恰好置位/清理一次）；
  // 这里手动置位是为了让 printToPDF 拿到「打印态」的 DOM。
  await page.eval("document.body.dataset.printing = '1'");

  /**
   * 出一份 PDF，返回字节数。
   * `preferCSSPageSize: true` 是这条断言的全部意义：让 CSS 的
   * `@page { size:A4; margin:14mm }` 说了算，而不是 CDP 的默认 Letter。
   */
  const pdfBytes = async (pageRanges) => {
    const res = await page.send('Page.printToPDF', {
      preferCSSPageSize: true,
      printBackground: true,
      ...(pageRanges ? { pageRanges } : {}),
    });
    return Math.floor((String(res.data ?? '').length * 3) / 4);
  };

  const bytes = await pdfBytes();
  check(
    '★ printToPDF 产出非空字节（> 1 KB；**不解析内容**，A-02）',
    bytes > 1024,
    `${bytes} B（${Math.round(bytes / 1024)} KB）`,
  );

  /**
   * 页数用「按范围出纸的字节数」间接证明，而不是去正则数 `/Type /Page`
   * （A-02：Chrome 用 /ObjStm 压缩对象流，正则静默给 0 —— 一个永远通过的假断言）：
   *   - 只要第 2 页有字，`1-2` 就一定比 `1` 大；
   *   - 文档只有 2 页时，`1-3` 会被裁到 2 页，产出与 `1-2` 等长。
   */
  const bytes1 = await pdfBytes('1');
  const bytes12 = await pdfBytes('1-2');
  const bytes13 = await pdfBytes('1-3');
  await page.eval("delete document.body.dataset.printing");

  check(
    '★ 打印真的分成了 2 页（第 2 页确有内容，不是压成 1 页）',
    bytes12 > bytes1 * 1.2,
    `1 页=${bytes1} B，1-2 页=${bytes12} B`,
  );
  check(
    '★ 恰好 2 页（1-3 与 1-2 等长 → 第 3 页是空的）',
    bytes13 <= bytes12 * 1.02,
    `1-2 页=${bytes12} B，1-3 页=${bytes13} B`,
  );
  // 注意：这里**不**断言「纸张是 A4」。「@page size:A4 进了产物」由①的文本断言负责，
  // 「打印媒体下几何正确」由③的 computed style 负责；而从 PDF 里读 MediaBox 需要解析
  // 压缩对象流（A-02 的坑），宁缺勿假。

  /* ================================================================ 汇总 */

  console.log('');
  console.log(`断言 ${results.length - failed}/${results.length} 通过`);
  if (failed > 0) {
    console.log('');
    for (const row of results.filter((item) => !item.ok)) {
      console.log(`✗ ${row.label}${row.detail ? `  →  ${row.detail}` : ''}`);
    }
    console.log(`\n宿主页留在 ${WORK}（排查用）`);
    process.exitCode = 1;
  } else {
    console.log('打印门禁通过：装饰消失、分页保护生效、零外部请求、能出纸。');
    // 成功就清掉现场（Edge 配置目录几十 MB）；失败才留着给人排查
    try {
      rmSync(WORK, { recursive: true, force: true });
    } catch {
      /* Windows 上浏览器刚退出时文件可能还被占着 —— 清不掉就算了，它在 tmp 里 */
    }
  }
} catch (error) {
  console.error(`\n✗ 门禁执行失败：${error instanceof Error ? error.message : String(error)}`);
  console.error(`宿主页留在 ${WORK}（排查用）`);
  process.exitCode = 1;
} finally {
  session.close();
}
