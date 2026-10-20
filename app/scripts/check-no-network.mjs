/**
 * 「零网络请求」守门人。
 *
 * 产品的核心承诺之一是：打开这个页面，浏览器**不会**为它发出任何请求
 * （没有任何统计、没有上报、没有 CDN、没有「检查更新」）。
 * 这类承诺很容易在某次「顺手加个数据上报」里破掉，而且破掉之后没人会发现 ——
 * 因为界面上一切正常。
 *
 * 所以这里做静态扫描：`app/src` 与 `extension/` 里出现网络 API 就直接失败。
 * 允许例外，但必须写进 `no-network-allowlist`（默认是空的，加一条就要解释一条）。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..');

/** 扫这些目录（相对 repo 根） */
const SCAN_ROOTS = ['app/src', 'extension'];

/** 只扫这些扩展名 */
const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.html', '.htm', '.css']);

/** 跳过这些目录 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.tmp']);

const RULES = [
  { id: 'fetch', regex: /\bfetch\s*\(/, why: '浏览器 fetch' },
  { id: 'xhr', regex: /\bXMLHttpRequest\b/, why: 'XMLHttpRequest' },
  { id: 'beacon', regex: /\.sendBeacon\s*\(/, why: 'navigator.sendBeacon' },
  { id: 'websocket', regex: /\bnew\s+WebSocket\b/, why: 'WebSocket' },
  { id: 'eventsource', regex: /\bnew\s+EventSource\b/, why: 'EventSource（SSE）' },
  { id: 'remote-import', regex: /\bimport\s*\(\s*['"`]https?:/, why: '动态 import 远程模块' },
  { id: 'remote-script', regex: /<script[^>]+src\s*=\s*['"]https?:/i, why: '远程 <script src>' },
  { id: 'service-worker', regex: /navigator\.serviceWorker/, why: 'Service Worker（会引入后台请求）' },
  /*
   * 下面三条是 v0.3 补的：前三版只扫 JS，「零请求」其实留了三个 CSS/HTML 的口子。
   * 最常见的破法不是写 fetch，而是有人为了「字体好看一点」加一句
   * `@import url(https://fonts.googleapis.com/...)` —— 页面看起来一切正常，
   * 但每次打开都会向 Google 发一次请求，隐私承诺当场作废。
   */
  // 前置 `[^A-Za-z0-9_$]` 是为了不误伤 `adapterForUrl('https://...')` 这类函数调用
  { id: 'css-url', regex: /(?:^|[^A-Za-z0-9_$])url\(\s*['"]?https?:/i, why: 'CSS url() 引用远程资源（字体 / 图片）' },
  { id: 'css-import', regex: /@import\s+(?:url\()?\s*['"]?https?:/i, why: 'CSS @import 远程样式表' },
  { id: 'remote-link', regex: /<link[^>]+href\s*=\s*['"]https?:/i, why: '远程 <link href>（字体 / 图标 / 样式）' },
];

/**
 * 读 allowlist：每行一个相对路径（可带 `# 原因`）。
 * 例：`app/src/lib/foo.ts  # 只用了 URL.createObjectURL，扫描器误报`
 */
function loadAllowlist() {
  const candidates = [resolve(repoRoot, 'no-network-allowlist'), resolve(repoRoot, '.github/no-network-allowlist')];
  const allowed = new Set();
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const raw = readFileSync(file, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      const cleaned = line.split('#')[0].trim();
      if (!cleaned) continue;
      allowed.add(cleaned.replace(/\\/g, '/').replace(/^\.\//, ''));
    }
  }
  return allowed;
}

/** 递归收集文件 */
function collect(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      collect(full, out);
    } else if (CODE_EXTS.has(extOf(name))) {
      out.push(full);
    }
  }
}

function extOf(name) {
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index).toLowerCase();
}

/**
 * 把注释内容替换成空格（保留换行与列位置，方便报告准确行号）。
 * 字符串字面量里的 `//` 会被误判成注释 —— 对本扫描来说无所谓：
 * 只会漏掉「写在字符串里的网络调用」，而那本身也不是网络调用。
 */
function stripComments(source) {
  let inBlock = false;
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false;
        out += '  ';
        index += 2;
        continue;
      }
      out += char === '\n' ? '\n' : ' ';
      index += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlock = true;
      out += '  ';
      index += 2;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        out += ' ';
        index += 1;
      }
      continue;
    }

    out += char;
    index += 1;
  }
  return out;
}

const allowlist = loadAllowlist();
const files = [];
for (const root of SCAN_ROOTS) {
  const absolute = resolve(repoRoot, root);
  if (!existsSync(absolute)) continue;
  collect(absolute, files);
}

if (files.length === 0) {
  console.error('✗ 没找到要扫描的文件（app/src 与 extension/ 都不存在？）');
  process.exit(1);
}

const hits = [];

for (const file of files) {
  const rel = relative(repoRoot, file).split(sep).join('/');
  const isAllowed = allowlist.has(rel) || allowlist.has(rel.split('/').pop() ?? '');
  if (isAllowed) continue;

  const raw = readFileSync(file, 'utf-8');
  const lines = stripComments(raw).split(/\r?\n/);
  const originalLines = raw.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    for (const rule of RULES) {
      if (!rule.regex.test(lines[i])) continue;
      hits.push({
        rel,
        line: i + 1,
        rule: rule.id,
        why: rule.why,
        snippet: (originalLines[i] ?? '').trim().slice(0, 120),
      });
    }
  }
}

console.log(`扫描 ${files.length} 个文件（${SCAN_ROOTS.join('、')}），规则 ${RULES.length} 条。`);

if (allowlist.size > 0) {
  console.log(`allowlist 生效 ${allowlist.size} 条：${[...allowlist].join('、')}`);
}

if (hits.length === 0) {
  console.log('✓ 没有发现网络调用。这个页面打开时不会向任何服务器发请求。');
  process.exit(0);
}

console.error(`\n✗ 发现 ${hits.length} 处网络调用：\n`);
for (const hit of hits) {
  console.error(`  ${hit.rel}:${hit.line}  [${hit.rule}] ${hit.why}`);
  console.error(`      ${hit.snippet}`);
}

console.error('\n处理方式：删掉它；或者如果确实是误报，把文件路径写进 no-network-allowlist 并注明原因。');
console.error('不接受「先这样，以后再清理」—— 隐私承诺一旦破掉就补不回来了。');
process.exit(1);
