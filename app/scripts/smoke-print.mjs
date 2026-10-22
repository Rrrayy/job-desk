/**
 * 打印门禁（ARCH §6.2 的 L2 + L3）—— `node scripts/smoke-print.mjs`
 *
 * 为什么需要真浏览器：`@media print` 的每一条规则都只在**打印媒体**下成立，
 * jsdom 不评估媒体查询（L1 只能证明编排顺序，证明不了 CSS 生效）。
 * 而这类 bug 的形态恰好是「代码看起来全对、打印出来一塌糊涂」：
 * `!important` 被后面的规则盖掉、选择器拼错一个字母、`@page` 被 minify 掉、
 * 3 种 layout 里有一种把正文挤出了纸面。
 *
 * 三个领域，各测各能测的：
 *   L2（真布局）  ：逐套模板切到打印媒体量 computed style（装饰消失 / 分页保护 / 不溢出）
 *   L2（零网络）  ：订阅 `Network.requestWillBeSent`，确认整页只加载 file:/data:
 *   L3（能出纸）  ：`Page.printToPDF` 产出**非空字节（> 1 KB）即过**
 *
 * ★ L3 **不解析 PDF 内容**（A-02 教训）：Chrome 用 `/ObjStm` 压缩对象流，
 *   正则数 `/Type /Page` 会静默返回 0 —— 一个「永远通过」的假断言比没有断言更坏。
 *   页数用 `pageRanges` 的字节长度间接证明（`1` vs `1-2` vs `1-3`），不读 PDF。
 *
 * 被测页面两处，各司其职：
 *   ① `dist/index.html`（真实产物）：`@page` 全仓唯一、CSS 里确实带了打印规则、零外部请求
 *   ② `scripts/print-harness/harness.tsx`（esbuild 现场打）：真组件 + 真样式，
 *      因为 T05 之前 `A4Preview` / `TemplatePicker` 还没有生产消费方，
 *      真产物里没有 `.a4` 元素 —— 对着不存在的元素断言是最糟的假测试。
 *      宿主页把模板清单（id/layout/name）挂在 `window.__templates` 上，
 *      脚本按**应用自己声明的**布局去断言 DOM，不在脚本里抄第二份真相。
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
  check(
    '3 种 layout 变体进了产物（single / double / timeline）',
    ['.a4--double', '.a4--timeline'].every((sel) => cssText.includes(sel)),
  );

  const realExternal = realRequests.external();
  realRequests.stop();
  check('真实产物零外部请求', realExternal.length === 0, realExternal.slice(0, 3).join(' | ') || `共 ${realRequests.urls.length} 条，全是本地`);

  /* ================================================================ ② 逐套模板 */

  const harnessRequests = await collectRequests();
  await page.send('Page.navigate', { url: fileUrl(HARNESS_HTML) });
  await waitFor(page, "document.documentElement.dataset.harnessReady === '1'", { label: 'harness 渲染完成' });

  const templates = await page.eval('window.__templates');
  check(
    '宿主页暴露了 8 套模板的声明（id / layout / name）—— 脚本不抄第二份真相',
    Array.isArray(templates) && templates.length === 8,
    Array.isArray(templates) ? templates.map((t) => `${t.id}:${t.layout}`).join(' ') : String(templates),
  );

  /** 逐套模板：screen → print 两轮渲染，各量一遍 */
  for (const template of templates ?? []) {
    const prefix = `[${template.id}]`;
    await page.send('Page.navigate', { url: `${fileUrl(HARNESS_HTML)}?tpl=${template.id}` });
    await waitFor(page, "document.documentElement.dataset.harnessReady === '1' && !!document.querySelector('.a4 .rs-item')", {
      label: `${template.id} 渲染完成`,
    });

    /* ---------------- screen：内容真的进纸了、没横向溢出 ---------------- */
    const screen = await page.eval(`
      (() => {
        const root = document.documentElement;
        const a4 = document.querySelector('.a4');
        const body = document.querySelector('.a4__body');
        const bodyRect = body.getBoundingClientRect();
        // 溢出的判定：任何正文块伸出纸的内容盒右边界 1px 以上
        const spill = [...document.querySelectorAll('.rs-section, .rs-item, .rs-bullets, .rs-item__line, .rs-photo')]
          .filter((el) => el.getBoundingClientRect().right > bodyRect.right + 1).length;
        return {
          tpl: a4.dataset.tpl,
          className: a4.className,
          sections: document.querySelectorAll('.rs-section').length,
          items: document.querySelectorAll('.rs-item').length,
          photos: document.querySelectorAll('.rs-photo').length,
          pages: document.querySelector('.a4-fit').dataset.pages,
          // 页面级横向滚动条（验收 7 的另一半）
          docOverflowX: root.scrollWidth - root.clientWidth,
          spill,
          bodyWidth: Math.round(bodyRect.width),
        };
      })()
    `);

    check(`${prefix} 渲染的是这套模板自己的布局（a4--${template.layout}）`, screen.tpl === template.id && screen.className.includes(`a4--${template.layout}`), `${screen.tpl} / ${screen.className}`);
    check(`${prefix} 正文真的进纸了（≥4 个板块、≥4 个条目）`, screen.sections >= 4 && screen.items >= 4, `板块 ${screen.sections}、条目 ${screen.items}、页数 ${screen.pages}`);
    check(`${prefix} 内容没有伸出纸面（无横向溢出）`, screen.spill === 0 && screen.docOverflowX <= 0, `溢出块 ${screen.spill}、文档横向溢出 ${screen.docOverflowX}px`);

    /* ---------------- print：装饰消失 + 分页保护 ---------------- */
    await page.send('Emulation.setEmulatedMedia', { media: 'print' });
    await sleep(120);

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
        /**
         * 打印态里**可见**的装饰数量，而不是「第一个元素存在且是 none」：
         * 单栏内容一页装得下时断点列表为空，压根就没有分页线 ——
         * 「不存在」与「存在但隐藏」都算过，只有「存在且可见」才是 bug。
         */
        const visibleCount = (sel) =>
          [...document.querySelectorAll(sel)].filter((el) => getComputedStyle(el).display !== 'none').length;
        const title = cs('.rs-section__title');
        const items = [...document.querySelectorAll('.rs-item')];
        const sections = [...document.querySelectorAll('.rs-section')];
        const bodyRect = document.querySelector('.a4__body').getBoundingClientRect();
        const spill = [...document.querySelectorAll('.rs-section, .rs-item, .rs-bullets, .rs-item__line, .rs-photo')]
          .filter((el) => el.getBoundingClientRect().right > bodyRect.right + 1).length;
        return {
          matchPrint: matchMedia('print').matches,
          fitTransform: fit.transform,
          fitWidthPx: Math.round(document.querySelector('.a4-fit').getBoundingClientRect().width),
          a4WidthPx: Math.round(document.querySelector('.a4').getBoundingClientRect().width),
          a4BoxShadow: a4.boxShadow,
          bodyPadding: body.padding,
          guideDisplay: guide ? guide.display : 'no-guide',
          pageNoDisplay: pageNo ? pageNo.display : 'no-guide',
          guidesTotal: document.querySelectorAll('.a4__guide').length,
          guidesVisible: visibleCount('.a4__guide'),
          pageNosVisible: visibleCount('.a4__page-no'),
          itemsTotal: items.length,
          itemsAvoid: items.filter((el) => prop(getComputedStyle(el), 'break-inside') === 'avoid').length,
          sectionsAvoid: sections.filter((el) => prop(getComputedStyle(el), 'break-inside') === 'avoid').length,
          sectionsTotal: sections.length,
          titleBreakAfter: prop(title, 'break-after'),
          colorAdjust: prop(a4, 'print-color-adjust') || prop(a4, '-webkit-print-color-adjust'),
          spill,
        };
      })()
    `);

    check(
      `${prefix} 打印：transform 归零 + 阴影消失 + 装饰隐藏`,
      printed.fitTransform === 'none' && printed.a4BoxShadow === 'none' && printed.guidesVisible === 0 && printed.pageNosVisible === 0,
      `transform=${printed.fitTransform} shadow=${printed.a4BoxShadow} 分页线 ${printed.guidesVisible}/${printed.guidesTotal} 可见、页码 ${printed.pageNosVisible} 可见`,
    );
    check(`${prefix} 打印：页边距只由 @page 提供（body padding 0）`, printed.bodyPadding === '0px', printed.bodyPadding);
    check(
      `${prefix} ★ 打印：每个条目/板块都 break-inside:avoid`,
      printed.itemsTotal > 0 && printed.itemsAvoid === printed.itemsTotal && printed.sectionsAvoid === printed.sectionsTotal,
      `条目 ${printed.itemsAvoid}/${printed.itemsTotal}、板块 ${printed.sectionsAvoid}/${printed.sectionsTotal}`,
    );
    check(`${prefix} ★ 打印：板块标题 break-after:avoid（不留在页底孤行）`, printed.titleBreakAfter === 'avoid', printed.titleBreakAfter);
    check(`${prefix} 打印：颜色保真 + 内容仍在可打印区内`, printed.colorAdjust === 'exact' && printed.spill === 0, `color-adjust=${printed.colorAdjust} 溢出块=${printed.spill}`);

    await page.send('Emulation.setEmulatedMedia', { media: '' });
  }

  /* ================================================================ ③ 缩放机制 */

  console.log('\n【③ 缩放：mm 一份真相 + 外层 scale（窄窗口 520px）】');
  await page.send('Page.navigate', { url: `${fileUrl(HARNESS_HTML)}?tpl=tech-single` });
  await waitFor(page, "document.documentElement.dataset.harnessReady === '1' && !!document.querySelector('.a4 .rs-item')", { label: 'harness 渲染完成' });

  const wide = await page.eval(`
    (() => {
      const fitEl = document.querySelector('.a4-fit');
      const a4El = document.querySelector('.a4');
      return {
        scale: fitEl.style.getPropertyValue('--a4-scale'),
        fitTransform: getComputedStyle(fitEl).transform,
        a4LayoutWidth: Number.parseFloat(getComputedStyle(a4El).width),
        a4VisualWidth: Math.round(a4El.getBoundingClientRect().width),
      };
    })()
  `);
  check('屏幕：外层真有 scale（预览靠这一层缩放，不是改字号）', /^matrix\(/.test(wide.fitTransform) && Number(wide.scale) > 0 && Number(wide.scale) <= 1, `--a4-scale=${wide.scale}`);
  check('屏幕：A4 布局宽 = 210mm 实宽（96dpi 下 ≈ 793.7px）', Math.abs(wide.a4LayoutWidth - 793.7) <= 1, `${wide.a4LayoutWidth}px`);
  check('屏幕：视觉宽 = 实宽 × scale（缩的是纸，不是纸上的字号）', Math.abs(wide.a4VisualWidth - wide.a4LayoutWidth * Number(wide.scale)) <= 2, `视觉 ${wide.a4VisualWidth}px`);

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

  /* ================================================================ ④ 打印作用域 */

  console.log('\n【④ 打印作用域：只摘界面壳，不摘内容】');
  // 这些隐藏规则写在 @media print 里 → 必须先切到打印媒体，否则量到的是屏幕样式
  await page.send('Emulation.setEmulatedMedia', { media: 'print' });
  await sleep(120);
  const scoped = await page.eval(`
    (() => {
      const cs = (sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).display : 'missing';
      };
      const before = { entry: cs('.print-entry'), form: cs('.resume__form'), toolbar: cs('.resume__toolbar'), picker: cs('.tpl-picker') };
      document.body.dataset.printing = '1';
      const during = { entry: cs('.print-entry'), form: cs('.resume__form'), toolbar: cs('.resume__toolbar'), a4: cs('.a4') };
      delete document.body.dataset.printing;
      const after = { entry: cs('.print-entry') };
      return { before, during, after };
    })()
  `);
  check('★ body[data-printing] 期间：打印按钮/表单/工具条全部 display:none', scoped.during.entry === 'none' && scoped.during.form === 'none' && scoped.during.toolbar === 'none', `entry=${scoped.during.entry} form=${scoped.during.form} toolbar=${scoped.during.toolbar}`);
  check('★ 简历本体仍可见（只摘壳，不摘内容）', scoped.during.a4 !== 'none', scoped.during.a4);
  check('★ 没有 data-printing 时不隐藏（规则被作用域限定，不是全局摘顶栏）', scoped.after.entry !== 'none', `before=${scoped.before.entry} after=${scoped.after.entry}`);
  check(
    '模板选择器（8 张卡）在屏幕上可见 —— 它挂在打印作用域之外也没被误伤',
    scoped.before.picker !== 'none' && scoped.before.picker !== 'missing',
    scoped.before.picker,
  );

  const harnessExternal = harnessRequests.external();
  harnessRequests.stop();
  check('宿主页零外部请求（8 套模板 × 逐页导航）', harnessExternal.length === 0, harnessExternal.slice(0, 3).join(' | ') || `共 ${harnessRequests.urls.length} 条，全是本地`);

  /* ================================================================ ⑤ L3 PDF */

  console.log('\n【⑤ L3：Page.printToPDF（3 种布局各出一份）】');
  await page.send('Emulation.setEmulatedMedia', { media: 'print' });

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

  /** 每种布局抽一套（布局是打印风险的来源，模板名不是） */
  const PDF_SAMPLES = ['tech-single', 'campus-general', 'social-simple'];
  for (const id of PDF_SAMPLES) {
    await page.send('Page.navigate', { url: `${fileUrl(HARNESS_HTML)}?tpl=${id}` });
    await waitFor(page, "document.documentElement.dataset.harnessReady === '1' && !!document.querySelector('.a4 .rs-item')", {
      label: `${id} 渲染完成`,
    });
    // 真实流程里这个属性由 printResume 置位（L1 已断言它恰好置位/清理一次）；
    // 这里手动置位是为了让 printToPDF 拿到「打印态」的 DOM。
    await page.eval("document.body.dataset.printing = '1'");
    const bytes = await pdfBytes();
    await page.eval("delete document.body.dataset.printing");
    check(`★ [${id}] printToPDF 产出非空字节（> 1 KB；**不解析内容**，A-02）`, bytes > 1024, `${bytes} B（${Math.round(bytes / 1024)} KB）`);
  }

  /**
   * 页数用「按范围出纸的字节数」间接证明，而不是去正则数 `/Type /Page`
   * （A-02：Chrome 用 /ObjStm 压缩对象流，正则静默给 0 —— 一个永远通过的假断言）：
   *   - 页数 P 从预览拿（`data-pages`，与打印同一把尺子）；
   *   - 出 `1…P-1` 与 `1…P`：后者明显更大 → 第 P 页确有内容（没被压成一页）；
   *   - 再出 `1…P+1`：与 `1…P` 等长 → 没有第 P+1 页（范围被裁到实际页数）。
   *
   * ★ 页数必须在**屏幕媒体**下读（这里刻意先 `setEmulatedMedia ''` 再导航）：
   *   屏幕上 `.a4` 恒为 210mm、内边距 14mm，正文宽 182mm —— 与纸上（@page 边距 14mm）
   *   逐毫米相同，所以预览量到的流就是打印的流。
   *   而在 `media:'print'` 的窗口里 `.a4 { width:auto }` 会退化成「窗口宽」，
   *   正文比纸面宽、行数更少、流更矮 —— 拿它读页数会得出一个比真实打印少的数
   *   （第一版就是这么写的：预览 2 页、真打印 3 页，差点把产品代码改成迁就错误测量）。
   */
  await page.send('Emulation.setEmulatedMedia', { media: '' });

  for (const id of PDF_SAMPLES) {
    await page.send('Emulation.setEmulatedMedia', { media: '' });
    await page.send('Page.navigate', { url: `${fileUrl(HARNESS_HTML)}?tpl=${id}` });
    await waitFor(page, "document.documentElement.dataset.harnessReady === '1' && !!document.querySelector('.a4 .rs-item')", { label: `${id} 渲染完成` });
    await sleep(120); // 让 ResizeObserver 完成首帧测量（scale 与分页都在这一帧定下来）
    const expectedPages = Number(await page.eval("document.querySelector('.a4-fit').dataset.pages"));
    /**
     * 量一遍预览看到的「连续流」：板块的 top/height 与内容总高（**已换算回 CSS px**）。
     * 页数不一时，这几个数字是唯一能定位「是分页模型错了、还是块太高、还是缩放没换算」的证据。
     */
    const flow = JSON.parse(
      await page.eval(`(() => {
        const body = document.querySelector('.a4__body');
        const cs = getComputedStyle(body);
        const padT = parseFloat(cs.paddingTop);
        const bodyRect = body.getBoundingClientRect();
        const a4Rect = body.parentElement.getBoundingClientRect();
        const scale = a4Rect.width > 0 ? a4Rect.width / ((210 * 96) / 25.4) : 1;
        const blocks = [...body.children]
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { top: Math.round((r.top - bodyRect.top) / scale - padT), h: Math.round(r.height / scale) };
          })
          .filter((b) => b.h > 0);
        return JSON.stringify({
          scale: Math.round(scale * 100) / 100,
          content: Math.round(bodyRect.height / scale - padT - parseFloat(cs.paddingBottom)),
          tall: blocks.filter((b) => b.h > 1017).length,
          blocks: blocks.length,
          flow: blocks.map((b) => b.top + '+' + b.h).join(' '),
          guides: document.querySelectorAll('.a4__guide').length,
        });
      })()`),
    );
    await page.send('Emulation.setEmulatedMedia', { media: 'print' });
    await page.eval("document.body.dataset.printing = '1'");
    const head = await pdfBytes(`1-${Math.max(1, expectedPages - 1)}`);
    const full = await pdfBytes(`1-${expectedPages}`);
    const extra = await pdfBytes(`1-${expectedPages + 1}`);
    await page.eval("delete document.body.dataset.printing");
    await page.send('Emulation.setEmulatedMedia', { media: '' });

    // 「最后一页确有内容」用**增量字节**判断，不用比例：末页本来就比首页轻一半，
    // 比例阈值(1.2×)会把「真的分了两页」判成失败（第一版就踩了这个）。
    // 一张**空页**只会多出页面对象与交叉引用表（1～2 KB 量级），4096 B 高于噪声、远低于真内容。
    check(
      `[${id}] ★ 打印真的分成了多页（最后一页确有内容，不是压成一页）`,
      expectedPages < 2 || full - head > 4096,
      `预览 ${expectedPages} 页；1-${Math.max(1, expectedPages - 1)} 页=${head} B，1-${expectedPages} 页=${full} B（第 ${expectedPages} 页 +${full - head} B）`,
    );
    check(
      `[${id}] ★ 打印页数 = 预览页数（1-${expectedPages + 1} 与 1-${expectedPages} 等长 → 没有多余的第 ${expectedPages + 1} 页）`,
      extra <= full * 1.02,
      `1-${expectedPages} 页=${full} B，1-${expectedPages + 1} 页=${extra} B；` +
        `预览 scale=${flow.scale} content=${flow.content}px 块=${flow.blocks}（超高 ${flow.tall}）断点=${flow.guides}\n    流：${flow.flow}`,
    );
  }
  // 注意：这里**不**断言「纸张是 A4」。「@page size:A4 进了产物」由①的文本断言负责，
  // 「打印媒体下几何正确」由②的 computed style 负责；而从 PDF 里读 MediaBox 需要解析
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
    console.log('打印门禁通过：8 套模板装饰消失、分页保护生效、不溢出、零外部请求、能出纸。');
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
