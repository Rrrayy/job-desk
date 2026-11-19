/**
 * 产物体积红线。
 *
 * 这个项目承诺「一个 index.html 双击就能用」，代价是 JS + CSS 全部内联进 HTML。
 * 体积一旦失控，首屏就会出现明显白屏，所以把它变成 CI 的一道门：
 *
 *   > WARN 只提示，不失败（还有优化空间，但不影响交付）
 *   > FAIL 必须处理：拆功能、砍依赖，或者重新想一遍「这一屏真的需要吗」
 *
 * 口径与 PRD §D.4 一致：**未压缩**的 dist/index.html 字节数（1 KB = 1024 B）。
 * 不用 gzip 后的大小，因为产品是本地文件打开，没有 CDN 帮你压缩。
 *
 * ★ v0.3 为什么把红线从 600 KB 收到 540 KB：
 *   600 KB 是"永远不会响的警报"—— v0.2 才 422 KB，占 72%，
 *   等于给后续开发留了 178 KB 的空白支票，而这张支票一旦花完，第一反应一定是"再调高一点"。
 *   收紧到 540 KB 之后，当前（v0.3.0）占 80%，剩下的 88 KB 大约等于"再做一个同量级功能"
 *   就要停下来优化 —— 这才是红线该有的手感：不痛不痒的阈值等于没有阈值。
 *
 * ★ v0.5 为什么把 WARN 提到 490 KB、FAIL 保持 540 KB：
 *   v0.5 一次落了五个地基功能（存储后端抽象、回收站、导入增量合并、
 *   便携包、列表窗口化），实测 479 KB。此时 470 的水位会**常态报警**，
 *   而常态报警等于没有报警 —— 与 v0.3 把 600 收到 540 是同一条逻辑的反向应用。
 *   所以只把 WARN 抬到 490（留 11 KB 余量），FAIL 不动。
 *
 * ★ v0.6 为什么把 WARN 抬到 540 KB、FAIL 抬到 560 KB（这是**产品决策**，不是技术决策）：
 *   v0.6 是加密 + 文件联动 + CSV 导入三个自带新 UI 面的功能，实测 531 KB。
 *   在动阈值之前先做了完整的构成测量（见 docs/RELEASE-NOTES-v0.6.0.md「为什么体积是 531 KB」）：
 *
 *   - React 18 + react-dom 生产版压缩后 **142 KB**，是硬地板，砍不掉；
 *   - 本轮新增的 6 个模块压缩后合计只有 **28 KB**
 *     （crypto 5.6 / csvImport 6.9 / link-engine 10.3 / handle 1.5 / pending 1.4 / hash 2.3）；
 *   - 剩下的增量全部是 UI，而且**不是虚胖**：新增 2 个面板 13.4 KB 压缩后是
 *     1307 处 className、1467 处 children、约 15 K 汉字的产品文案 ——
 *     这些正是这个产品「把风险说清楚」的那部分（只读三出口、冲突解释、诚实声明），
 *     删它们省下来的 KB 比失去的可信度贵得多；
 *   - gzip 后仅 **159 KB**；file:// 打开是本地读盘，不受网络影响。
 *
 *   所以 v0.6 的选择是：**承认体积上了一个台阶，同时把 FAIL 只抬到 560**（现有 +29 KB 余量，
 *   约等于「再做一个中等功能就要先优化」）。不把 FAIL 一次抬到 600 ——
 *   那正是 v0.3 批评过的「空白支票」。
 *   v0.6 之后的红线回到「每版只随基线浮动」的节奏，下一版起默认不再动 FAIL。
 *
 * ★ v0.7（JD 链接延伸 + BOSS 卡片解析）：WARN/FAIL 不动。
 *   新增 parseJdText + extractJdSections（纯函数约 3 KB）、JdPanel 面板与样式（约 7 KB）、
 *   快捷键与 safeHref（<1 KB），预计 +11～14 KB，会越过 WARN（WARN 只提示不失败），
 *   离 FAIL 仍留 15 KB 以上。这是「贴近水位就留记录」惯例的执行，不是抬线。
 *
 * ★ v0.7.2（同步确认面板：解析模板 + 人工指定状态）：WARN/FAIL 不动。
 *   新增 PASTE_TEMPLATES 五平台复制样板（约 4 KB）、Step3Confirm 状态选择器与
 *   SyncDrawer.handleManualStatus（约 2 KB）及样式，实测 +13 KB（531→544），越过 WARN，
 *   离 FAIL 仍有 16 KB。红线不动，构成在此留痕。
 *
 * ★ v0.8（插件框架 + AI 基础版 + 求职管线扩展）：WARN 540→585、FAIL 560→600。
 *   这是**产品决策**，不是技术顺手。用户 2026-10-22 明确批准抬线（"不用砍功能 可以抬线"）。
 *   实际构成（T01–T05 累计，实测而非估算）：
 *     管线数据层与迁移 3→4      ≈ +6.5 KB
 *     管线 UI（7 列/徽章/面板）  ≈ +3.3 KB
 *     AI 核心（gateway/suggestions/日志） ≈ +3.7 KB
 *     插件宿主（broker/sandbox/storage/manifest）+ 管理面板 ≈ +18 KB
 *       —— 这一项远超 ARCH 的 3 KB 预估：五项强制校验 + 逐条 RPC 错误码 + 面板 UI 都是老实代码
 *   T03 时 gateway/预览被 tree-shake 掉，T04 接线后才真正进产物，所以数字是台阶式的。
 *   实测落点 597.7 KB（T05 三场景 13.1 KB + 此前一直被 tree-shake 的 prompts/SuggestionList 5.5 KB）。
 *   **600 是「不抬到 600」承诺的边界线**：FAIL 600 只剩 2.3 KB 余量，等于本版把这张支票用满了。
 *   v0.8.1 的第一件事必须是体积优化（看板窗口化 + 文案复用 + 场景面板合并），把落点压回 ≤585，
 *   否则 v1.0 不启动、任何新功能不排期。
 *
 * ★ v0.9.0 定稿（2026-10-22）：WARN 600→690、FAIL 600→715（简历模块 + 4 AI 场景 + 整段录入，落点 680.7）。
 *   实测落点 597.7 KB（612,047 B），距 FAIL 余量 2.3 KB。
 *   **600 是「不抬到 600 的空白支票」这条承诺的边界线** ——
 *   踩在线上，所以 v0.8.1 必须先做体积优化（看板列窗口化 + 文案复用）把落点压回 ≤585，
 *   否则 v1.0 不启动。这条不是建议，是发版条件。
 *
 *   为什么 T05 的预算（+4 KB）没守住：三场景 UI + 设置面板实测 +17.5 KB。三处估算漏项：
 *   ① prompts.ts(3.7)+SuggestionList(1.8) 在 T01–T04 被 tree-shake 掉，T05 接线才进产物；
 *   ② 三场景共用主干（预览→流式→窄校验→建议→撤销）本身 6 KB 量级；
 *   ③ 设置面板过半是必须说清楚的风险文案（明文 key / 不出公网 / 只发勾选字段）。
 *   已按裁决做过瘦身，实测合计 −0.8 KB（合并三个场景包装组件、设置页与场景说明两轮文案压缩、
 *   去掉面板内 token 流显示、删三条 v0.4 遗留的死 CSS），落点 598.5 → 597.7 KB。
 *   裁决目标 ≤596 KB 还差 1.7 KB：剩下的空间要么把 20 组重复原子类抽成 class token
 *   （约 −2.3 KB，代价是 JSX 里类名不再可 grep）、要么砍功能 —— 后者被明确禁止，
 *   前者是拿可读性换字节。本轮选守住可读性，把 1.7 KB 记为欠账，转 v0.8.1。
 *
 * ★ v0.9 · T00 体积偿还（2026-10-22，WARN/FAIL 数值本轮不动，红线调整由主理人统一改）：
 *
 *   1) 预算公式（ARCH-v09 §0.3 实测校准，估算产物增量用这个，不要「感觉差不多」）：
 *        产物增量 KB ≈ 0.52 × 去注释代码 KB + 3 B × 新增汉字数 + 0.74 × 新增 CSS 源 KB
 *      依据（v0.8.0 产物实测）：CSS 62.6 KB（源 86,963 B × 0.74）、JS 533.8 KB（其中
 *      React+ReactDOM ≈ 142 KB 是硬地板）、中文 18,401 字 = 55.2 KB（minifier 不动中文，
 *      1 字 = 3 B）。注释不进产物，随便写。
 *
 *   2) T00 实测（基线 612,047 B = 597.7 KB）：
 *      - 删死 CSS：0 条可删（25 个疑似全是模板字符串动态拼接类名，杠杆已用尽）；
 *      - 同选择器重复 22 组/27 次：其中绝大多数是**跨 @media 断点的响应式覆写**，
 *        合并会破坏窄屏布局，不可动；真正可安全合并的是「声明体完全相同的规则组」，
 *        按层叠安全性（同 media 条件 + 逐条 specificity 比对 + JSX 类名共现实证）合并
 *        57 组、吸收 98 条规则，实测 −3.9 KB；
 *      - 重复中文常量：逐条扣除「常量声明 + import + 改用常量名」开销后，
 *        真正净省的只有 2 组（App.tsx 导出失败提示 ×7、migrate/storage 备份过新提示 ×4），
 *        ≈ −0.3 KB——短串（≤12 B）跨文件抽取是负收益，得不偿失；
 *      - 落点 607,657 B = 593.4 KB（−4.4 KB），满足 T00 验收 ≤595 KB。
 *      验证方式：styles.css 合并前后「选择器 × 声明」语义并集逐条比对一致 +
 *      真实 Chromium 5 视图 × 10 档宽度 + 3 个抽屉/浮层共 59 张截图逐字节相同。
 *
 *   3) v0.9 目标：T01–T08 叠加 +82 KB，落点 ≈ 677.7 KB（区间 672–684）；
 *      红线拟 WARN 690 / FAIL 715（「常态响的警报等于没有警报」的同一逻辑，
 *      数值由主理人定案后另行改动，本文件本轮不动）。
 *
 *   4) v0.9 实际：简历模块（8 模板 + A4 打印 + 4 AI 场景）体量超出预估
 *      （T07 四场景实测 +17.9 KB vs 预算 14）。主理人裁决「超出预算就把上限再往上提」：
 *      WARN 690→705 / FAIL 715→730（T07b+T08 落点预估 ≈692，WARN 留 13 KB 余量，
 *      FAIL 仍保持「再做一个小功能才需要回头优化」的手感）。
 *      这是一次明确的产品决策，理由与构成记入 docs/RELEASE-NOTES-v0.9.0.md。
 *
 * ★ v0.9.1「遗留问题清理版」（2026-10-23，WARN/FAIL 数值本轮不动，红线调整由主理人按 Q1 统一改）：
 *
 *   这一版**不是功能版**，是还债版。预算与实测（基线 719,686 B = 702.8 KB）：
 *
 *     T1  体积偿还（类名 token 化 −9.58 KB）＋主版本 toast ＋勘误   实测 −8.61 KB
 *     T2  旧数据归类（LegacyBindPanel）＋改绑撤销点                 实测 +6.18（预算 +3.5）
 *     T3  回收站分区 ＋ 报告历史 ＋ 配额告知                        实测 +5.72（预算 +6.0）
 *     T4  看板窗口 40 ＋ 简历到期告知 ＋ 启动告知纯函数             实测 +1.59（预算 +3.5）
 *     T5  打印 hint 层 UA 分支 ＋ 发布脚本 ＋ 文档                  见下
 *   最终落点 **708.5 KB**（725,474 B，T5 收尾）→ 越过 v0.9.0 的 WARN 705 共 3.5 KB，距 FAIL 730 还有 21.5 KB。
 *
 *   为什么越了 WARN 却没被砍：T1 已经用「运行时类名映射」把当前架构下的体积杠杆基本用尽
 *   （Top100 串值 −9.58 KB，剩下 636 个长尾串值全做只能再省 3 KB，而每条映射自身也要占字节）。
 *   T2 超预算的部分是**改绑撤销点**——那是 v0.9 宣称做了、实际没做的功能（文档与代码不符），
 *   属于还债不属于扩张。主理人 Q1 裁决：**WARN 705 → 715，FAIL 730 不动**（2026-10-26 主理人亲自落地）。
 *   抬幅 +10（v0.9 那次是 +15），性质不同：v0.9 抬线是为容纳一个新能力域，本次只为让
 *   「把已有能力做完整」的工作不被红线卡住；FAIL 不动以保持「再做一个小功能才需要回头优化」的手感。
 *   抬线后余量 6.5 KB，够本版返工 —— 不许再拿这 6.5 KB 塞新功能。
 *
 *   ★ 类名 token 化给后续所有版本留下一条硬约束（架构 B-17 / B-02）：
 *     ① 新写的 className 若串值已在 `src/lib/classTokens.ts` 的 `CLS` 表里，必须写 `CLS.x`，
 *        不许写回字面量 —— 否则收益被稀释回去，`npm run check:classes` 会红；
 *     ② 低频串（只出现一两次）**保持字面量**：塞进表里，条目成本（len(V)+len(t)+4）盖过收益；
 *     ③ `--check` 的第 6 条断言是黄金副本等价：表里任何一格被改动（哪怕只是多一个空格、
 *        或两个原子顺序颠倒）都会红 —— 这类改动 round-trip 断言抓不住，但 DOM 已经变了。
 *
 * ★ 改动阈值必须写进 docs/RELEASE-NOTES：涨红线不是技术决策，是产品决策。
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ★ v0.10（模型层全面升级）：WARN 715→960、FAIL 730→1024（1 MB）。
 *   这是**产品决策**：用户 2026-11-09 明确批准「体积可以直接拉到 1 mb」。
 *   本轮构成（均为老实代码，非依赖膨胀）：八场景 prompt 重写（含正例/反例/自检）、
 *   配置向导与连通性自检、生成阶段化面板、建议 diff 与报告导出、用量面板。
 *   红线抬到 1 MB 之后仍然保留「本次比基线胖了 20 KB 就提示」的增量告警 ——
 *   抬总闸不等于拆警报器。
 */
const WARN_BYTES = 960 * 1024;
const FAIL_BYTES = 1024 * 1024;

/**
 * ★ v2 · C6：总量红线拆成三项（CSS / JS / 中文）。
 *
 * ## 为什么总量红线不够
 *
 * 产物到 819 KB 时，总量闸门只会说「胖了」。而**能采取的动作完全取决于胖子是谁**：
 *   - CSS 胖 → 合并规则组、删死 CSS（改 `src/styles.css`）；
 *   - JS 胖 → 砍功能、换小依赖（改 `src/**`，且**不能**靠拆包，见下）；
 *   - 中文胖 → 压文案（改界面文字，3 B/字 的硬成本）。
 * 三种动作互不相同，给错了方向就是白干一天。所以总量闸门保留（它是真失败闸门），
 * 另加三项分项红线，超了直接红 —— 分项不是「参考值」。
 *
 * ## 怎么从单文件里切出这三项（口径，实测得出，不是估的）
 *
 * 构建产物是一个 html，三块结构：
 *   1. **CSS** = 所有 `<style>…</style>` 的**内容**字节和（不含标签）。本仓 `cssCodeSplit:false`
 *      + `cssMinify:'esbuild'`，全部样式都在这里，没有外部 .css 文件。
 *   2. **JS** = 所有 `<script>…</script>` 的**内容**字节和（不含标签）。`viteSingleFile()` 把
 *      entry chunk 内联成**一个** script。
 *   3. **外壳** = 总字节 − CSS − JS（`<!doctype>`/`<head>`/`<body>` 与标签本身，实测 ~1.2 KB）。
 *
 * **中文** = 全文里 CJK 统一表意文字（U+4E00–U+9FFF）的**字数 × 3 B**。
 *   为什么是 3 B：这些码位全在 BMP，UTF-8 恒为 3 字节，而且 minifier 不碰中文 ——
 *   一个汉字省不掉，所以它是一条**独立的成本维度**，不能和 CSS/JS 混在一起看。
 *   只数表意文字、不数标点：中文标点（U+3000–303F）与全角形式（U+FF00–FFEF）另有约 8 KB，
 *   混进来会让「字数」这个用户能理解的指标失真。想看全量非 ASCII 成本时：
 *   本版实测 90.0 KB（含标点与全角），表意文字部分 79.5 KB。
 *
 * ★ **三项不可相加**：中文就长在 JS 里（本版 27,146 个汉字里 27,029 个在 script 内、
 *   117 个在外壳、0 个在 CSS）。CSS + JS + 外壳 = 总量；中文是总量内部的构成。
 *   报告里必须写明这一点，否则后来人会拿三项去求和，然后以为脚本算错了。
 *
 * ## 阈值怎么定的（本版实测基线，2026-11-19，产物 842,492 B）
 *
 *   CSS    91,009 B =  88.9 KB   → 红线 100 KB（占 89%）
 *   JS    750,284 B = 732.7 KB   → 红线 780 KB（占 94%；其中 React+ReactDOM ≈ 142 KB 是地板）
 *   中文   27,146 字 =  79.5 KB   → 红线  85 KB（占 94%；再涨 1,867 字就红）
 *
 * 三项都留**同量级**的余量（6%–11%），不是给某一项开空白支票：
 * 一个中等功能的增量（v0.9 实测 +5～18 KB）刚好能触发对应那一项，
 * 触发时你会被指着去动正确的地方，而不是笼统地「优化体积」。
 * 抬任何一项之前先问：**这一项真的该长吗**，理由写进 docs/RELEASE-NOTES。
 */
const SUB_LIMITS = {
  css: 100 * 1024,
  js: 780 * 1024,
  cjk: 85 * 1024,
};

/**
 * 当前版本的体积基线（每次发版更新，用来在 CI 里显示「这次改动胖了多少」）。
 * 它的作用不是判失败，而是让体积增长**可见** —— 静悄悄长胖是最难回头的技术债。
 * v0.9.0：703 KB（简历模块 + 5 AI 场景发布落点 719,686 B = 702.8 KB，取整 703）。
 */
const BASELINE_BYTES = 708 * 1024;

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const target = resolve(appRoot, 'dist/index.html');

/** 人类可读：1.2 MB / 278 KB */
function human(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

if (!existsSync(target)) {
  console.error('✗ 找不到 dist/index.html —— 先跑 npm run build');
  process.exit(1);
}

const bytes = statSync(target).size;
const ratio = (bytes / FAIL_BYTES) * 100;
const delta = bytes - BASELINE_BYTES;
const deltaText = `${delta >= 0 ? '+' : '-'}${human(Math.abs(delta))}`;

/* ------------------------------ 分项测量 ------------------------------ */

const STYLE_RE = /<style[^>]*>([\s\S]*?)<\/style>/gi;
const SCRIPT_RE = /<script[^>]*>([\s\S]*?)<\/script>/gi;

/** CJK 统一表意文字个数（U+4E00–U+9FFF；UTF-8 恒 3 B/字，minifier 不碰） */
function countCjk(text) {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x4e00 && cp <= 0x9fff) n += 1;
  }
  return n;
}

/**
 * 把单文件产物切成 CSS / JS / 外壳 + 中文。返回单位全部是**字节**。
 * 切不出来就返回 `error`：产物结构变了（比如哪天不再内联）宁可红，
 * 也不能静默报 0 然后「通过」—— 那正是「常态绿灯」的来源。
 */
function measureComposition(html, totalBytes) {
  const styles = [...html.matchAll(STYLE_RE)].map((match) => match[1]);
  const scripts = [...html.matchAll(SCRIPT_RE)].map((match) => match[1]);
  if (styles.length === 0) {
    return { error: '产物里找不到内联 <style> —— 切分口径失效，先更新本脚本再谈红线' };
  }
  if (scripts.length === 0) {
    return { error: '产物里找不到内联 <script> —— 切分口径失效，先更新本脚本再谈红线' };
  }

  const cssBytes = styles.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0);
  const jsBytes = scripts.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0);
  const cjkCss = countCjk(styles.join(''));
  const cjkJs = countCjk(scripts.join(''));
  const cjkShell = countCjk(html) - cjkCss - cjkJs;
  const cjkChars = cjkCss + cjkJs + cjkShell;

  if (cjkChars === 0) {
    return { error: '全文数出 0 个汉字 —— 要么文案全没了，要么读取编码坏了，都不该静默通过' };
  }

  return {
    cssBytes,
    jsBytes,
    shellBytes: totalBytes - cssBytes - jsBytes,
    styleBlocks: styles.length,
    scriptBlocks: scripts.length,
    cjkChars,
    cjkBytes: cjkChars * 3,
    cjkCss,
    cjkJs,
    cjkShell,
  };
}

const comp = measureComposition(readFileSync(target, 'utf8'), bytes);
if (comp.error) {
  console.error(`✗ ${comp.error}`);
  process.exit(1);
}

const pctOf = (used, limit) => `${Math.round((used / limit) * 100)}%`;
const kbOf = (value) => (value / 1024).toFixed(1);

console.log(`产物：dist/index.html`);
console.log(`体积：${human(bytes)}（${bytes} B / 总上限 ${human(FAIL_BYTES)}，占 ${ratio.toFixed(0)}%）`);
console.log(`基线：${human(BASELINE_BYTES)}（本次 ${deltaText}）`);
console.log(
  `水位：总 WARN ${human(WARN_BYTES)} · FAIL ${human(FAIL_BYTES)}｜分项 CSS ${human(SUB_LIMITS.css)} · JS ${human(SUB_LIMITS.js)} · 中文 ${human(SUB_LIMITS.cjk)}`,
);
console.log('');
console.log('分项（三项互相重叠、**不可相加** —— 中文就长在 JS 和 CSS 里面）：');
console.log(
  `  CSS   ${kbOf(comp.cssBytes).padStart(6)} KB / ${String(SUB_LIMITS.css / 1024).padStart(3)} KB   ${pctOf(comp.cssBytes, SUB_LIMITS.css).padStart(4)}   <style> ×${comp.styleBlocks}（全部样式，无外部 .css）`,
);
console.log(
  `  JS    ${kbOf(comp.jsBytes).padStart(6)} KB / ${String(SUB_LIMITS.js / 1024).padStart(3)} KB   ${pctOf(comp.jsBytes, SUB_LIMITS.js).padStart(4)}   <script> ×${comp.scriptBlocks}（其中 React/ReactDOM ≈ 142 KB 是地板）`,
);
console.log(
  `  中文  ${kbOf(comp.cjkBytes).padStart(6)} KB / ${String(SUB_LIMITS.cjk / 1024).padStart(3)} KB   ${pctOf(comp.cjkBytes, SUB_LIMITS.cjk).padStart(4)}   ${comp.cjkChars.toLocaleString('en-US')} 字 × 3 B（在 JS 内 ${comp.cjkJs.toLocaleString('en-US')} · 外壳 ${comp.cjkShell.toLocaleString('en-US')} · CSS ${comp.cjkCss.toLocaleString('en-US')}）`,
);
console.log(`  外壳  ${kbOf(comp.shellBytes).padStart(6)} KB /   —   <html>/<head> 框架，不计入任何红线`);

/* ------------------------------ 判定 ------------------------------ */

/**
 * 每条红线各自带一份「该动哪里」：分项红线存在的唯一理由就是给出方向。
 * 汇总后一次性打印并 exit 1 —— 分项超阈值和总量超阈值一样是**失败**，不是提示。
 */
const breaches = [];

if (bytes > FAIL_BYTES) {
  breaches.push({
    title: `总量超出红线：${human(bytes)} > ${human(FAIL_BYTES)}（超 ${human(bytes - FAIL_BYTES)}）`,
    detail: [
      `这个产品是靠「单文件、双击就能用」立身的，超过 ${human(FAIL_BYTES)} 首屏会明显变慢。`,
      '处理方向只有两条：**砍功能**，或者**压文案**。先看上面的分项，确认是 CSS / JS / 中文 哪一项胖了再动手。',
      '注意：本仓 vite.config.ts 是 viteSingleFile() + assetsInlineLimit: 100 MB，',
      '动态 import() 的 chunk 也会被内联回同一个 html —— 「把低频功能按需拆出去」在本仓架构上不存在，',
      '照着那句去拆包，文件一个字节都不会小。',
    ],
  });
}

if (comp.cssBytes > SUB_LIMITS.css) {
  breaches.push({
    title: `CSS 超出分项红线：${kbOf(comp.cssBytes)} KB > ${SUB_LIMITS.css / 1024} KB（占 ${pctOf(comp.cssBytes, SUB_LIMITS.css)}，超 ${kbOf(comp.cssBytes - SUB_LIMITS.css)} KB）`,
    detail: [
      '该动哪里：**动样式**，不要去动 JS 和文案 —— 这一项超了说明胖的是 CSS 本身。',
      '全部样式来自 src/styles.css（cssCodeSplit:false + cssMinify:esbuild，压完内联进 <style>）。',
      '能用手段按收益排序：① 合并同 @media 条件下声明体完全相同的规则组；',
      '② 删死 CSS —— 模板字符串拼出来的类名 grep 不到，要先搜 `${`；③ 收敛重复的原子类（见 classTokens）。',
    ],
  });
}

if (comp.jsBytes > SUB_LIMITS.js) {
  breaches.push({
    title: `JS 超出分项红线：${kbOf(comp.jsBytes)} KB > ${SUB_LIMITS.js / 1024} KB（占 ${pctOf(comp.jsBytes, SUB_LIMITS.js)}，超 ${kbOf(comp.jsBytes - SUB_LIMITS.js)} KB）`,
    detail: [
      '该动哪里：**动代码**，不要去动样式和文案 —— 删文案省下的那点钱填不上这个坑。',
      'React + ReactDOM 生产版 ≈ 142 KB 是硬地板，砍不掉；地板之上的部分才是你能动的。',
      '本仓架构下「按需拆包」不存在（viteSingleFile 会把动态 import 也内联），能做的只有：',
      '① 砍功能；② 换更小的依赖（手写 30 行通常比 30 KB 的依赖划算）；③ 删重复的工具函数。',
    ],
  });
}

if (comp.cjkBytes > SUB_LIMITS.cjk) {
  breaches.push({
    title: `中文文案超出分项红线：${kbOf(comp.cjkBytes)} KB（${comp.cjkChars.toLocaleString('en-US')} 字）> ${SUB_LIMITS.cjk / 1024} KB（占 ${pctOf(comp.cjkBytes, SUB_LIMITS.cjk)}，超 ${(comp.cjkChars - Math.floor(SUB_LIMITS.cjk / 3)).toLocaleString('en-US')} 字）`,
    detail: [
      '该动哪里：**压文案**，不要去动 CSS / JS 结构 —— 这一项超了说明胖的是界面文字。',
      '中文是 3 B/字 的硬成本，minifier 一个字都压不掉：砍 1,000 字 ≈ 省 2.9 KB。',
      `当前分布：JS ${comp.cjkJs.toLocaleString('en-US')} 字 · 外壳 ${comp.cjkShell.toLocaleString('en-US')} 字 · CSS ${comp.cjkCss.toLocaleString('en-US')} 字 —— 文案几乎都在 JS 里，所以压文案会连带把 JS 那一项也压小。`,
      '找法：同一个提示在 N 个面板各写一遍是最常见的浪费（注意短串跨文件抽常量是负收益，v0.9 T00 实测过）。',
    ],
  });
}

if (breaches.length > 0) {
  for (const breach of breaches) {
    console.error(`\n✗ ${breach.title}`);
    for (const line of breach.detail) console.error(`  ${line}`);
  }
  console.error('\n不要第一反应就调高阈值 —— 那等于把警报器拆了。');
  process.exit(1);
}

if (bytes > WARN_BYTES) {
  console.warn(`\n⚠ 已过警戒线：${human(bytes)} > ${human(WARN_BYTES)}（还没到红线，但该看看哪里胖了）`);
  console.warn('  先看上面分项：超的那一项会告诉你该动 CSS / JS / 中文 里的哪一个。');
  process.exit(0);
}

if (delta > 20 * 1024) {
  // 单次改动涨超过 20 KB，几乎一定是有意无意引入了大依赖（日期库、图标库、polyfill）
  console.warn(`\n⚠ 本次比基线胖了 ${deltaText}。确认一下这不是顺手引了个库。`);
  console.warn('  分项里哪一项涨得最多，就是它。');
}

console.log('\n✓ 体积在预算内（总量 + CSS / JS / 中文 三项分项全绿）');
