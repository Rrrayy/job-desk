/**
 * 产物体积红线。
 *
 * 这个项目承诺「一个 index.html 双击就能用」，代价是 JS + CSS 全部内联进 HTML。
 * 体积一旦失控，首屏就会出现明显白屏，所以把它变成 CI 的一道门：
 *
 *   > 470 KB  WARN   只提示，不失败（还有优化空间，但不影响交付）
 *   > 540 KB  FAIL   必须处理：拆功能、砍依赖，或者重新想一遍「这一屏真的需要吗」
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
 * ★ 改动阈值必须写进 docs/RELEASE-NOTES：涨红线不是技术决策，是产品决策。
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WARN_BYTES = 470 * 1024;
const FAIL_BYTES = 540 * 1024;

/**
 * 当前版本的体积基线（每次发版更新，用来在 CI 里显示「这次改动胖了多少」）。
 * 它的作用不是判失败，而是让体积增长**可见** —— 静悄悄长胖是最难回头的技术债。
 */
const BASELINE_BYTES = 441 * 1024;

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
const kb = bytes / 1024;
const ratio = (bytes / FAIL_BYTES) * 100;
const delta = bytes - BASELINE_BYTES;
const deltaText = `${delta >= 0 ? '+' : '-'}${human(Math.abs(delta))}`;

console.log(`产物：dist/index.html`);
console.log(`体积：${human(bytes)}（${kb.toFixed(1)} KB / 上限 ${human(FAIL_BYTES)}，占 ${ratio.toFixed(0)}%）`);
console.log(`基线：${human(BASELINE_BYTES)}（本次 ${deltaText}）`);
console.log(`水位：WARN ${human(WARN_BYTES)} · FAIL ${human(FAIL_BYTES)}`);

if (bytes > FAIL_BYTES) {
  console.error(`\n✗ 超出红线：${human(bytes)} > ${human(FAIL_BYTES)}`);
  console.error('  这个产品是靠「单文件、双击就能用」立身的，超过 540 KB 首屏会明显变慢。');
  console.error('  处理方向：把低频功能（面经编辑器 / 社区导入）按需拆出去，或砍掉重复的工具函数。');
  console.error('  不要第一反应就调高阈值 —— 那等于把警报器拆了。');
  process.exit(1);
}

if (bytes > WARN_BYTES) {
  console.warn(`\n⚠ 已过警戒线：${human(bytes)} > ${human(WARN_BYTES)}（还没到红线，但该看看哪里胖了）`);
  console.warn('  提示：npm run build 之后可以用 `npx vite-bundle-visualizer` 看构成。');
  process.exit(0);
}

if (delta > 20 * 1024) {
  // 单次改动涨超过 20 KB，几乎一定是有意无意引入了大依赖（日期库、图标库、polyfill）
  console.warn(`\n⚠ 本次比基线胖了 ${deltaText}。确认一下这不是顺手引了个库。`);
}

console.log('\n✓ 体积在预算内');
