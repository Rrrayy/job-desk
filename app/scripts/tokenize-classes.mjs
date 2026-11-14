#!/usr/bin/env node
/**
 * tokenize-classes.mjs —— 类名 token 化（v0.9.1 T1-a，架构 B-02 / B-03）
 *
 * ## 这个脚本在解决什么
 *
 * 产物 `dist/index.html` 里 1,700+ 处 `className` 字面量重复出现同样的长串
 * （`btn btn--small` × 76、`field__label` × 75 …）。把**整条 className 串值**
 * 收进一张运行时映射表 `CLS`，源码写 `CLS.a`，运行时求值出的**仍是原串**。
 *
 * 关键点：DOM 输出逐字节不变 —— React 往 DOM 里写的还是 `btn btn--small`，
 * 所以 105 处测试类名断言、61 处 CDP 选择器、DevTools 里看到的东西全部不受影响。
 * 这是「运行时映射」相对「构建期改名」的决定性优势（架构 §1.1.5）。
 *
 * ## 为什么必须按频次截断（这条别自行放宽）
 *
 * 映射表条目本身有成本（`t:'V',` ≈ len(V)+len(t)+4）与表壳开销。
 * 一个串值的净收益 = n × (len(V) − len(t)) − (len(V) + len(t) + 4)。
 * 长尾串值只有 2–3 次出现，盖不住条目成本。架构师实测（真实 esbuild minify）：
 *
 *   Top50 → −8.39 KB   Top100 → −9.48 KB ← 执行点   Top150 → −9.59 KB   全量 736 → −3.09 KB
 *
 * 「顺手全做」会从 −9.48 掉到 −3.09。所以硬上限 100 条，写死在 `MAX_ENTRIES`。
 *
 * ## 只碰纯字面量（风险归零的硬约束）
 *
 * 任何含 `${` 的模板串一律不动。这条把 9 个动态片段 + 8 个动态类名家族
 * （`stars--${n}` / `qb__mastery--${n}` / `a4--${layout}` …）全部自动排除。
 *
 * ## 用法
 *
 *   node scripts/tokenize-classes.mjs --check     # 只断言、不写文件（进 npm run verify）
 *   node scripts/tokenize-classes.mjs --write     # 生成 classTokens.ts + 改写源文件
 *   node scripts/tokenize-classes.mjs --golden    # 有意改表后重新录制黄金副本（见断言 6）
 *   node scripts/tokenize-classes.mjs --stats     # 只打印统计（排查用，不写不判）
 *
 * `--check` 的六条断言（缺一条就等于没有护栏）：
 *   1. 漏网：没有任何「值在表里」的纯字面量还留在源码里（应替换的全替换了）
 *   2. round-trip：表里每个串值的每个类名原子，都在 `src/styles.css` 里存在
 *      （证明表里的类名不是凭空造的）；dist 存在时一并校验
 *   3. 无重复：没有重复 key、没有重复 value（重复 value = 统计口径错了）
 *   4. 条目数 ≤ 100（B-02 硬上限，防止后人顺手加满把收益归零）
 *   5. 选表一致性：用「现有表 + 残留字面量」重算频次与**入选集合**，结果必须与现有表一致
 *      （只比集合、不比 token 分给谁 —— 后者是优化，写进门禁会让每加一个按钮都要求
 *      重生成 50 个文件的 token 名）
 *   6. 黄金副本等价：表与 `classTokens.golden.json` **逐条全等**（QA 复核补的护栏）
 *
 * ## 断言 6 堵的是什么（这条别删）
 *
 * 断言 2 只看「串值里的每个类名原子在 CSS 里存在」，所以这两种**串值被改坏**
 * 的情况它全都放行：
 *
 *   `'btn  btn--small'`（多一个空格）→ 两个原子都在，但 DOM 里多一个空 token
 *   `'btn--small btn'`（顺序颠倒）   → 两个原子都在，但层叠优先级可能翻转
 *
 * 而断言 5 只比**入选集合**，表里某个 value 被手改后，重算频次也是拿改后的 value
 * 去统计的（自指），同样抓不住。所以要有一份「改写当时逐字节记录的原始串值」
 * 作基准：表只要有一格变了，就必须有人显式跑 `--golden` 重新录制，
 * 从而在 diff 里留下「我确实动了这个串值」的痕迹。
 *
 * ★ 本文件是生成 + 改写工具，不是生成物；`src/lib/classTokens.ts` 是生成物。
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 硬上限：架构 B-02 / §1.1 的实测结论，改大改小都会破坏收益曲线。 */
export const MAX_ENTRIES = 100;

/** 1 字符 token 的槽位数（CSS 类名首字符必须合法，`a-zA-Z` 共 52 个）。 */
const SINGLE_TOKEN_SLOTS = 52;

/**
 * 已核实的「无对应 CSS 规则」类名原子白名单。
 *
 * round-trip 断言的目的是证明「表里的类名不是凭空造的」。绝大多数情况用
 * 「这个类名在 `styles.css` 里存在」来证明就够了；但有极少数类名是**源码里
 * 真的在用、CSS 里真的没有**的历史遗留（死类名），它们同样是真类名，
 * 只是没有样式。把它们逐条审计后记在这里，断言对**新增**的死类名仍然有效
 * （新增一个拼错的类名会让 `--check` 红）。
 *
 * v0.9.2：`btn--ghost` 已补上专属样式（`.btn--ghost`，8 处按钮生效），
 * 从本白名单移除 —— 白名单归零后，**任何**无样式类名都会让 `--check` 红。
 */
const KNOWN_UNSTYLED_ATOMS = new Set();

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = LOWER.toUpperCase();
const ALPHA = LOWER + UPPER;
const ALNUM = ALPHA + '0123456789';

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, '..', 'src');
const TABLE_FILE = resolve(SRC_ROOT, 'lib', 'classTokens.ts');
/** 黄金副本：`{token: 原串}`，只被 `--check` 与测试读，**不进产物** */
const GOLDEN_FILE = resolve(SRC_ROOT, 'lib', 'classTokens.golden.json');
const STYLES_FILE = resolve(SRC_ROOT, 'styles.css');
const DIST_FILE = resolve(here, '..', 'dist', 'index.html');

// ---------------------------------------------------------------------------
// 词法：把注释与模板串字面量片段遮成空格，索引不变，方便后续正则 + 偏移改写
// ---------------------------------------------------------------------------

/**
 * 对源码做一遍轻量词法扫描。
 *
 * 返回的 `code` 与 `src` **等长同索引**：注释字符与模板串的纯文本片段被替换成空格，
 * 常规字符串字面量的引号与内容原样保留（后续要按引号定位与读取值）。
 * `strings` 是常规字符串字面量（含引号）的 span 列表，用于判断某个参数是不是「纯字面量」。
 *
 * 为什么不用真正的 AST：本仓没有 TypeScript 编译器 API 的直接依赖权限顾虑，
 * 但引入 `typescript` 到脚本里会让 `--check` 多一层版本耦合；而我们需要的信息
 * 只是「这个位置是不是一个字符串字面量」，词法层面足够且可审计。
 *
 * @param {string} src
 * @returns {{ code: string, strings: Array<{start: number, end: number, quote: string, value: string}> }}
 */
export function lex(src) {
  const n = src.length;
  const chars = src.split('');
  /** @type {Array<{start:number,end:number,quote:string,value:string}>} */
  const strings = [];
  let i = 0;

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    // 行注释
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') {
        chars[i] = ' ';
        i += 1;
      }
      continue;
    }

    // 块注释
    if (c === '/' && next === '*') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') chars[i] = ' ';
        i += 1;
      }
      if (i < n) {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 2;
      }
      continue;
    }

    // 常规字符串字面量：记录 span，内容原样保留
    if (c === '"' || c === "'") {
      const start = i;
      const quote = c;
      i += 1;
      let closed = false;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i += 1;
          closed = true;
          break;
        }
        if (src[i] === '\n') break;
        i += 1;
      }
      if (closed) {
        strings.push({
          start,
          end: i,
          quote,
          value: decodeLiteral(src.slice(start + 1, i - 1)),
        });
      }
      continue;
    }

    // 模板串：字面量片段遮成空格，`${ … }` 里的表达式保持可读
    if (c === '`') {
      i += 1;
      while (i < n) {
        if (src[i] === '\\') {
          chars[i] = ' ';
          if (i + 1 < n) chars[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (src[i] === '`') {
          i += 1;
          break;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          // 跳到匹配的 `}`，表达式内部不处理字符串（本仓无此类嵌套需求）
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth += 1;
            else if (src[i] === '}') {
              depth -= 1;
              if (depth === 0) break;
            }
            i += 1;
          }
          i += 1;
          continue;
        }
        chars[i] = ' ';
        i += 1;
      }
      continue;
    }

    i += 1;
  }

  return { code: chars.join(''), strings };
}

/**
 * 解码一个字符串字面量的内容（只处理本仓会用到的转义）。
 *
 * @param {string} raw 去掉引号后的原始片段
 * @returns {string}
 */
export function decodeLiteral(raw) {
  return raw.replace(/\\(.)/g, (_m, ch) => {
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    if (ch === 'r') return '\r';
    return ch;
  });
}

/**
 * 从 `openIdx` 处的左括号找到匹配的右括号下标。
 *
 * 只跟踪同类括号的嵌套深度：调用点都是 `( … )` / `{ … }`，而 `[` `]` 不会
 * 在这两者之间造成不平衡，因此对实际代码是充分的。
 *
 * @param {string} code 已遮罩的源码
 * @param {number} openIdx
 * @returns {number} 匹配的右括号下标，找不到返回 -1
 */
export function findMatching(code, openIdx) {
  const open = code[openIdx];
  const close = open === '(' ? ')' : open === '{' ? '}' : open === '[' ? ']' : '';
  if (!close) return -1;
  let depth = 0;
  for (let i = openIdx; i < code.length; i += 1) {
    const c = code[i];
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 按顶层逗号切分一个参数列表。
 *
 * @param {string} code 已遮罩的源码
 * @param {number} from `(` 之后的下标
 * @param {number} to `)` 的下标
 * @returns {Array<[number, number]>} 每个参数的 [start, end) 区间
 */
export function splitArgs(code, from, to) {
  /** @type {Array<[number, number]>} */
  const spans = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i += 1) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) {
      spans.push([start, i]);
      start = i + 1;
    }
  }
  spans.push([start, to]);
  return spans;
}

/**
 * 在已遮罩的源码上，把 [from, to) 裁剪到首个 / 末个非空白字符。
 *
 * @param {string} code
 * @param {number} from
 * @param {number} to
 * @returns {[number, number] | null}
 */
export function trimSpan(code, from, to) {
  let a = from;
  let b = to;
  while (a < b && /\s/.test(code[a])) a += 1;
  while (b > a && /\s/.test(code[b - 1])) b -= 1;
  return b > a ? [a, b] : null;
}

// ---------------------------------------------------------------------------
// 扫描：抽出所有「类名串值出现处」
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ClassOccurrence
 * @property {string} value 整条 className 串值
 * @property {'attr' | 'attr-expr' | 'arg'} kind 出现形态
 * @property {number} start 需要被替换的区间起点（含）
 * @property {number} end 需要被替换的区间终点（不含）
 * @property {string} prefix `attr` / `attr-expr` 形态下需要原样保留的前缀（`className=`）
 */

/**
 * 扫一个文件里所有可 token 化的类名串值出现处。
 *
 * 只识别三种**纯字面量**形态（架构 §1.1.4 写死的规避方式）：
 *   1. `className="V"`
 *   2. `className={'V'}` / `className={"V"}`
 *   3. `cx('V', cond && 'W')` 里位于顶层参数位置的纯字面量 `'V'` / `'W'`
 *
 * 任何含 `${` 的模板串、任何变量 / 三元 / 拼接 / 调用表达式都不会被识别 ——
 * 这不是遗漏，是**故意**：动态类名家族 `stars--${n}` 等必须原样保留。
 *
 * @param {string} src
 * @returns {ClassOccurrence[]}
 */
export function scanOccurrences(src) {
  const { code, strings } = lex(src);
  /** @type {ClassOccurrence[]} */
  const found = [];

  /** @type {Map<number, {start:number,end:number,quote:string,value:string}>} */
  const stringAt = new Map();
  for (const s of strings) stringAt.set(s.start, s);

  /** 判断 [a, b) 是否恰好是**一个**字符串字面量（即「纯字面量参数」） */
  const literalSpan = (a, b) => {
    const s = stringAt.get(a);
    if (!s) return null;
    return s.end === b ? s : null;
  };

  // ---- 形态 1 / 2：className=… ----
  const attrRe = /\bclassName\s*=/g;
  let m;
  while ((m = attrRe.exec(code)) !== null) {
    const eqEnd = m.index + m[0].length;
    let p = eqEnd;
    while (p < code.length && /\s/.test(code[p])) p += 1;
    const ch = code[p];

    if (ch === '"') {
      const s = stringAt.get(p);
      if (s && !s.value.includes('${')) {
        found.push({
          value: s.value,
          kind: 'attr',
          start: m.index,
          end: s.end,
          prefix: src.slice(m.index, p),
        });
      }
      continue;
    }

    if (ch === '{') {
      const close = findMatching(code, p);
      if (close < 0) continue;
      const trimmed = trimSpan(code, p + 1, close);
      if (!trimmed) continue;
      const s = literalSpan(trimmed[0], trimmed[1]);
      if (s && !s.value.includes('${')) {
        found.push({
          value: s.value,
          kind: 'attr-expr',
          start: m.index,
          end: close + 1,
          prefix: src.slice(m.index, p),
        });
      }
    }
  }

  // ---- 形态 3：cx( … ) 的纯字面量参数 ----
  const cxRe = /\bcx\s*\(/g;
  while ((m = cxRe.exec(code)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = findMatching(code, open);
    if (close < 0) continue;
    for (const [from, to] of splitArgs(code, open + 1, close)) {
      const trimmed = trimSpan(code, from, to);
      if (!trimmed) continue;
      const s = literalSpan(trimmed[0], trimmed[1]);
      if (!s || s.value.includes('${')) continue;
      found.push({ value: s.value, kind: 'arg', start: s.start, end: s.end, prefix: '' });
    }
  }

  // 稳定排序：位置升序（改写时从后往前）
  found.sort((x, y) => x.start - y.start);
  return found;
}

// ---------------------------------------------------------------------------
// 表：读写 + token 分配
// ---------------------------------------------------------------------------

/**
 * 一个串值在某 token 长度下的净收益估算。
 *
 * 逐处省 `len(V) − len(t)`（`className:"V"` → `className:X.t`，两边都带
 * 同样的属性名 / 括号开销，差值就是字面量与 token 访问的差）；
 * 条目成本 `len(V) + len(t) + 4`（`t:'V',`）。
 *
 * @param {string} value
 * @param {number} count
 * @param {number} tokenLen
 * @returns {number}
 */
export function netGain(value, count, tokenLen) {
  return count * (value.length - tokenLen) - (value.length + tokenLen + 4);
}

/**
 * 依序生成 token 名：前 52 个用 1 字符（`a`…`Z`），其余用 2 字符。
 *
 * @param {number} n
 * @returns {string[]}
 */
export function tokenNames(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    if (i < SINGLE_TOKEN_SLOTS) {
      out.push(ALPHA[i]);
    } else {
      const k = i - SINGLE_TOKEN_SLOTS;
      out.push(ALPHA[Math.floor(k / ALNUM.length)] + ALNUM[k % ALNUM.length]);
    }
  }
  return out;
}

/**
 * 由「串值 → 出现次数」推出应有的表（值顺序 = token 分配顺序）。
 *
 * 两步：
 *   1. 按「2 字符 token 的净收益」降序取前 `MAX_ENTRIES` 个（决定**收哪些**）；
 *   2. 在这批里按出现次数降序重排（决定**谁拿短号** —— 每次出现都省 1 字节，
 *      所以短号给频次最高的）。
 *
 * 排序全部带确定性 tie-break，保证同一份输入永远产出同一张表（`--check` 依赖这点）。
 *
 * @param {Map<string, number>} counts
 * @returns {Array<{token: string, value: string, count: number}>}
 */
export function planTable(counts) {
  /** @type {Array<{value: string, count: number, score2: number}>} */
  const candidates = [];
  for (const [value, count] of counts.entries()) {
    if (count <= 0 || value.length === 0) continue;
    candidates.push({ value, count, score2: netGain(value, count, 2) });
  }
  candidates.sort((a, b) => {
    if (b.score2 !== a.score2) return b.score2 - a.score2;
    if (b.count !== a.count) return b.count - a.count;
    if (b.value.length !== a.value.length) return b.value.length - a.value.length;
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  });

  const chosen = candidates.slice(0, MAX_ENTRIES);
  chosen.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (b.score2 !== a.score2) return b.score2 - a.score2;
    if (b.value.length !== a.value.length) return b.value.length - a.value.length;
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  });

  const tokens = tokenNames(chosen.length);
  return chosen.map((c, i) => ({ token: tokens[i], value: c.value, count: c.count }));
}

/**
 * 把「按频次重排好的表」与「现有表」对齐，让**已在表里的串值沿用原 token**。
 *
 * 为什么要这一步：`planTable` 每次重算都会按最新频次重新分配短号，于是只要
 * 新写一个按钮（频次微调），`--write` 就会把 50 个源文件里的 `CLS.j` 改成
 * `CLS.aV` —— diff 几百行、收益几十字节、review 时真改动全被淹没。
 *
 * 沿用旧 token 让 `--write` 变成**增量**：新增串值拿空位 token，消失的串值
 * 释放 token，其余一格不动。净收益与最优分配只差几十字节（短号仍优先给
 * 高频串，只是「已在位的老串」不因排名小幅变动而搬家）。
 *
 * @param {Array<{token: string, value: string, count: number}>} plan 重算结果（已按频次排序）
 * @param {Array<{token: string, value: string}>} existing 现有表
 * @returns {Array<{token: string, value: string, count: number}>} 保持 plan 顺序、token 已对齐
 */
export function stablePlan(plan, existing) {
  const prevToken = new Map(existing.map((e) => [e.value, e.token]));
  const pool = tokenNames(plan.length);
  const pooled = new Set(pool);
  /** @type {Set<string>} */
  const used = new Set();
  /** @type {Array<{token: string, value: string, count: number}>} */
  const out = plan.map((e) => ({ token: '', value: e.value, count: e.count }));

  for (const e of out) {
    const prev = prevToken.get(e.value);
    if (!prev || !pooled.has(prev) || used.has(prev)) continue;
    e.token = prev;
    used.add(prev);
  }

  let cursor = 0;
  for (const e of out) {
    if (e.token) continue;
    while (cursor < pool.length && used.has(pool[cursor])) cursor += 1;
    if (cursor >= pool.length) break;
    e.token = pool[cursor];
    used.add(pool[cursor]);
    cursor += 1;
  }
  return out.filter((e) => e.token !== '');
}

/**
 * 读出现有的 `src/lib/classTokens.ts`。
 *
 * @param {string} [file]
 * @returns {Array<{token: string, value: string}> | null} 文件不存在返回 null
 */
export function readTable(file = TABLE_FILE) {
  if (!existsSync(file)) return null;
  const src = readFileSync(file, 'utf8');
  const body = src.slice(Math.max(0, src.indexOf('{')), src.lastIndexOf('}') + 1);
  /** @type {Array<{token: string, value: string}>} */
  const entries = [];
  const re = /([A-Za-z][A-Za-z0-9]*)\s*:\s*'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    entries.push({ token: m[1], value: decodeLiteral(m[2]) });
  }
  return entries;
}

/**
 * 渲染 `src/lib/classTokens.ts` 的完整内容。
 *
 * @param {Array<{token: string, value: string}>} entries
 * @returns {string}
 */
export function renderTable(entries) {
  const rows = entries
    .map((e) => `  ${e.token}: '${e.value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}',`)
    .join('\n');
  return `/**
 * 类名 token 表 —— 由 \`scripts/tokenize-classes.mjs\` 生成，**勿手改**。
 *
 * 存在的唯一理由：产物里 1,700+ 处 className 字面量中，少数长串值的出现次数
 * 占了接近六成；把它们收进这里换短 key，实测净省约 9.5 KB。运行时求值出的
 * **仍是原串**，所以 DOM、DevTools、105 处测试类名断言、61 处 CDP 选择器
 * 全部不受影响 —— 这是「运行时映射」相对「构建期改名」的决定性优势。
 *
 * ★ 纪律（架构 B-17）：新写的 className 若串值已在下面这张表里，必须写 \`CLS.x\`，
 *   不许写回字面量 —— 否则收益会被稀释回去。
 *   新写的**低频**串（一次性的、只出现一两次的）请保持字面量：把长尾串塞进表
 *   会让条目成本盖过收益（架构 §1.1 实测：全量 736 条只能省 3.09 KB，不如只做 100 条）。
 *
 * 重新生成：\`node scripts/tokenize-classes.mjs --write\`
 * 校验（进 npm run verify）：\`node scripts/tokenize-classes.mjs --check\`
 */
export const CLS = {
${rows}
} as const;
`;
}

// ---------------------------------------------------------------------------
// 黄金副本：`{token: 原串}` 的等价基准
// ---------------------------------------------------------------------------

/**
 * 读黄金副本。
 *
 * 用 JSON 而不是 `.ts`：它只给脚本和测试看，不需要类型、不需要被打进产物，
 * 而 JSON 能被 `JSON.parse` 直接读成普通对象，比对失败时 diff 也最好读。
 *
 * @param {string} [file]
 * @returns {Record<string, string> | null} 文件不存在或不是合法 JSON 时返回 null
 */
export function readGolden(file = GOLDEN_FILE) {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    /** @type {Record<string, string>} */
    const out = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') return null;
      out[key] = value;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * 渲染黄金副本（key 升序，保证同一张表每次写出同一个文件）。
 *
 * @param {Array<{token: string, value: string}>} entries
 * @returns {string}
 */
export function renderGolden(entries) {
  /** @type {Record<string, string>} */
  const obj = {};
  for (const e of [...entries].sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0))) {
    obj[e.token] = e.value;
  }
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/**
 * 比对表与黄金副本，返回人类可读的差异列表（空数组 = 完全等价）。
 *
 * 三类差异分开报，因为处置方式不同：
 * - **值被改动**：最危险，多半是手改表或改写器出了 bug（DOM 会变）
 * - **新增 / 消失**：多半是频次漂移导致重新生成过表（有意为之就重录黄金）
 *
 * @param {Array<{token: string, value: string}>} table
 * @param {Record<string, string>} golden
 * @returns {string[]}
 */
export function diffGolden(table, golden) {
  /** @type {string[]} */
  const diffs = [];
  const inTable = new Set();
  for (const e of table) {
    inTable.add(e.token);
    const want = golden[e.token];
    if (want === undefined) {
      diffs.push(`新增条目 ${e.token}: "${e.value}"（黄金副本里没有这一格）`);
      continue;
    }
    if (want !== e.value) {
      diffs.push(`值被改动 ${e.token}: 黄金副本 "${want}" / 现在是 "${e.value}"`);
    }
  }
  for (const [token, value] of Object.entries(golden)) {
    if (!inTable.has(token)) diffs.push(`条目消失 ${token}: "${value}"`);
  }
  return diffs;
}

/**
 * `--golden`：把当前表录制为黄金副本。
 *
 * 只有「确认这次改表是有意的」之后才该跑 —— 它把当前状态当成新的基准，
 * 因此**不会**被 `--write` 自动调用（自动调用等于没有护栏）。
 *
 * @returns {void}
 */
export function runGolden() {
  const table = readTable();
  if (!table) {
    console.error('✗ 找不到 src/lib/classTokens.ts —— 先跑 --write');
    return;
  }
  writeFileSync(GOLDEN_FILE, renderGolden(table), 'utf8');
  console.log(`✓ 录制黄金副本 src/lib/classTokens.golden.json（${table.length} 条）`);
}

// ---------------------------------------------------------------------------
// 工程：文件遍历 + 改写
// ---------------------------------------------------------------------------

/**
 * 递归收集 `src/` 下的源码文件（排除测试文件与生成物本身）。
 *
 * 测试文件排除的理由：测试不进产物，且必须保持可读 —— 把 105 处断言里的
 * `.ver-item__badge` 换成 `.CLS.x` 会把测试变成天书，而收益是零。
 *
 * @returns {string[]}
 */
export function collectSources() {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      if (/\.test\.(ts|tsx)$/.test(name)) continue;
      if (p === TABLE_FILE) continue;
      out.push(p);
    }
  };
  walk(SRC_ROOT);
  return out;
}

/**
 * 计算某个源文件 import `classTokens` 时应使用的相对路径。
 *
 * @param {string} file
 * @returns {string}
 */
export function importSpecifierFor(file) {
  let rel = relative(dirname(file), resolve(SRC_ROOT, 'lib', 'classTokens')).split(sep).join('/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

/** 已有的 import 语句（含 `from '…'` 形式与副作用 import） */
const IMPORT_RE = /^import\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"][^'"]+['"]\s*;?/gm;

/**
 * 在最后一个 import 语句之后插入一行 import（已有则不动）。
 *
 * @param {string} src
 * @param {string} line 形如 `import { CLS } from '../lib/classTokens';`
 * @returns {string}
 */
export function insertImport(src, line) {
  if (src.includes("from '" + line.split("from '")[1])) return src;
  let insertAt = 0;
  const re = new RegExp(IMPORT_RE.source, 'gm');
  let m;
  while ((m = re.exec(src)) !== null) {
    insertAt = m.index + m[0].length;
  }
  if (insertAt === 0) return `${line}\n${src}`;
  const nl = src.indexOf('\n', insertAt);
  const pos = nl === -1 ? src.length : nl + 1;
  return src.slice(0, pos) + `${line}\n` + src.slice(pos);
}

/**
 * 把一处出现替换成 `CLS.<token>` 形态的源码。
 *
 * @param {string} src
 * @param {ClassOccurrence} occ
 * @param {string} token
 * @returns {string}
 */
export function replacementFor(src, occ, token) {
  if (occ.kind === 'arg') return `CLS.${token}`;
  return `${occ.prefix}{CLS.${token}}`;
}

/**
 * 对单个文件做替换（返回新源码与被替换的处数）。
 *
 * @param {string} src
 * @param {Map<string, string>} tokenByValue
 * @returns {{ next: string, changed: number }}
 */
export function rewriteFile(src, tokenByValue) {
  const occs = scanOccurrences(src);
  const hits = occs.filter((o) => tokenByValue.has(o.value));
  if (hits.length === 0) return { next: src, changed: 0 };

  let next = src;
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    const o = hits[i];
    const token = /** @type {string} */ (tokenByValue.get(o.value));
    next = next.slice(0, o.start) + replacementFor(src, o, token) + next.slice(o.end);
  }
  return { next, changed: hits.length };
}

/**
 * 从「现有表 + 源码残留字面量」重算全量频次。
 *
 * 为什么要把现有表算进去：`--write` 跑过之后，被 token 化的串值在源码里
 * 已经不再是字面量，直接从源码统计会让它们「消失」，再跑一次就会选出另一张表
 * （不幂等）。把 `CLS.t` 的使用次数折算回去，`--write` 才能重复执行而稳定。
 *
 * @param {Array<{token: string, value: string}>} table
 * @param {string[]} files
 * @returns {{ counts: Map<string, number>, occurrences: number, byFile: Map<string, ClassOccurrence[]> }}
 */
export function collectCounts(table, files) {
  const valueByToken = new Map(table.map((e) => [e.token, e.value]));
  /** @type {Map<string, number>} */
  const counts = new Map();
  let occurrences = 0;
  /** @type {Map<string, ClassOccurrence[]>} */
  const byFile = new Map();

  // 现有表：用 token 使用次数补齐「已被改写掉」的那些出现
  for (const value of valueByToken.values()) counts.set(value, 0);

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const { code } = lex(src);
    // 统计 CLS.<token> 使用次数（\b 防止 a 误匹配 ab）
    for (const [token, value] of valueByToken.entries()) {
      const re = new RegExp(`\\bCLS\\.${token}\\b`, 'g');
      const hits = code.match(re);
      if (hits) {
        counts.set(value, (counts.get(value) ?? 0) + hits.length);
        occurrences += hits.length;
      }
    }
  }

  // 残留字面量
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const occs = scanOccurrences(src);
    byFile.set(file, occs);
    for (const o of occs) {
      counts.set(o.value, (counts.get(o.value) ?? 0) + 1);
      occurrences += 1;
    }
  }

  return { counts, occurrences, byFile };
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/**
 * 收集 `styles.css` 里出现过的所有类名原子（不含前导点）。
 *
 * @param {string} css
 * @returns {Set<string>}
 */
export function cssAtoms(css) {
  const set = new Set();
  const re = /\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g;
  let m;
  while ((m = re.exec(css)) !== null) set.add(m[1]);
  return set;
}

/**
 * 执行 `--check` 的全部断言。
 *
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function runCheck() {
  /** @type {string[]} */
  const lines = [];
  let ok = true;

  const fail = (msg) => {
    ok = false;
    lines.push(`  ✗ ${msg}`);
  };
  const pass = (msg) => lines.push(`  ✓ ${msg}`);

  const table = readTable();
  if (!table) {
    fail('找不到 src/lib/classTokens.ts —— 先跑 node scripts/tokenize-classes.mjs --write');
    return { ok: false, lines };
  }

  // 断言 3：无重复 key / 无重复 value
  const seenToken = new Set();
  const seenValue = new Set();
  let dupToken = 0;
  let dupValue = 0;
  for (const e of table) {
    if (seenToken.has(e.token)) dupToken += 1;
    if (seenValue.has(e.value)) dupValue += 1;
    seenToken.add(e.token);
    seenValue.add(e.value);
  }
  if (dupToken === 0 && dupValue === 0) pass(`表内 ${table.length} 条：key / value 均无重复`);
  else fail(`映射表有重复：${dupToken} 个重复 key、${dupValue} 个重复 value（统计口径错了）`);

  // 断言 4：条目数 ≤ MAX_ENTRIES
  if (table.length <= MAX_ENTRIES) pass(`条目数 ${table.length} ≤ ${MAX_ENTRIES}（B-02 硬上限）`);
  else fail(`条目数 ${table.length} 超过硬上限 ${MAX_ENTRIES}（全量做会从 −9.48 KB 掉到 −3.09 KB）`);

  const files = collectSources();
  const { counts, occurrences, byFile } = collectCounts(table, files);

  // 断言 1：漏网检查
  /** @type {Map<string, string>} */
  const tokenByValue = new Map(table.map((e) => [e.value, e.token]));
  let missed = 0;
  for (const [file, occs] of byFile.entries()) {
    for (const o of occs) {
      if (!tokenByValue.has(o.value)) continue;
      missed += 1;
      if (missed <= 5) {
        lines.push(`  ✗ 漏网：${relative(SRC_ROOT, file).split(sep).join('/')} —— "${o.value}" 应写 CLS.${tokenByValue.get(o.value)}`);
      }
    }
  }
  if (missed === 0) pass('漏网检查：应替换的字面量全部已替换（0 处残留）');
  else fail(`漏网检查：还有 ${missed} 处纯字面量应替换而未替换`);

  // 断言 2：round-trip（表里的类名必须在 CSS 里真实存在）
  const cssOk = existsSync(STYLES_FILE);
  /** @type {Set<string>} */
  const atoms = cssOk ? cssAtoms(readFileSync(STYLES_FILE, 'utf8')) : new Set();
  if (existsSync(DIST_FILE)) {
    for (const a of cssAtoms(readFileSync(DIST_FILE, 'utf8'))) atoms.add(a);
  }
  /** @type {string[]} */
  const missing = [];
  for (const e of table) {
    for (const atom of e.value.split(/\s+/).filter(Boolean)) {
      if (atoms.has(atom)) continue;
      if (KNOWN_UNSTYLED_ATOMS.has(atom)) continue;
      missing.push(`${atom}（来自 "${e.value}"）`);
    }
  }
  if (missing.length === 0) {
    pass(
      `round-trip：表内 ${table.length} 条串值的全部类名原子都能在 CSS 里找到` +
        `（${KNOWN_UNSTYLED_ATOMS.size} 个已审计的无样式类名白名单：${[...KNOWN_UNSTYLED_ATOMS].join('、')}）`,
    );
  } else {
    fail(`round-trip：${missing.length} 个类名原子在 CSS 里找不到 —— ${missing.slice(0, 8).join('、')}`);
  }

  // 断言 5：选表一致性（重算频次推出的**入选集合**必须与现有表一致）
  //
  // 只比集合、**不比 token 分配到哪个串值**：短号给最热的串是「优化」，不是「正确性」。
  // 若把顺序也写进门禁，那么以后每新写一个 `CLS.j` 按钮都会让频次排名微调、
  // 于是 `--check` 要求重生成 50 个文件的 token 名 —— 收益是几十字节，代价是每次
  // 功能开发都要滚一遍全仓 diff。集合比对已经能抓住真正要防的两件事：
  // ① 有人手改了表里的某个值（集合变了）；② 有人新写了高频类名却没重新生成（集合该变没变）。
  const expected = planTable(counts);
  const expectedValues = new Set(expected.map((e) => e.value));
  const actualValues = new Set(table.map((e) => e.value));
  const missingFromTable = expected.filter((e) => !actualValues.has(e.value));
  const extraInTable = table.filter((e) => !expectedValues.has(e.value));
  const expectedTokens = new Set(tokenNames(table.length));
  const actualTokens = new Set(table.map((e) => e.token));
  const tokenShapeOk =
    expectedTokens.size === actualTokens.size && [...expectedTokens].every((t) => actualTokens.has(t));

  if (missingFromTable.length === 0 && extraInTable.length === 0 && tokenShapeOk) {
    pass('选表一致性：入选的 100 个串值与重算结果完全一致，token 名构成合法（1 字符 52 + 2 字符 48）');
  } else {
    if (missingFromTable.length > 0) {
      lines.push(`  ✗ 该进表却没进：${missingFromTable.slice(0, 5).map((e) => `"${e.value}"×${e.count}`).join('、')}`);
    }
    if (extraInTable.length > 0) {
      lines.push(`  ✗ 在表里但不该在：${extraInTable.slice(0, 5).map((e) => `"${e.value}"`).join('、')}`);
    }
    if (!tokenShapeOk) lines.push('  ✗ token 名不是合法的 1/2 字符分配（有人手改过 key）');
    fail('选表一致性：现有表与重算结果不一致（有人手改过表，或 --write 后没重新生成）');
  }

  // 断言 6：黄金副本等价（逐条全等，堵住「串值被改坏但原子都还在」）
  const golden = readGolden();
  if (!golden) {
    fail('找不到 src/lib/classTokens.golden.json —— 跑一次 node scripts/tokenize-classes.mjs --golden');
  } else {
    const diffs = diffGolden(table, golden);
    if (diffs.length === 0) pass(`黄金副本等价：表内 ${table.length} 条与原串逐字节相同（多空格 / 顺序颠倒都会红）`);
    else {
      for (const d of diffs.slice(0, 5)) lines.push(`  ✗ ${d}`);
      fail(`黄金副本不等于现有表（${diffs.length} 处差异）—— 若确认是有意改表，跑 --golden 重录`);
    }
  }

  lines.unshift(
    `类名 token 化：${table.length}/${MAX_ENTRIES} 条，覆盖 ${occurrences} 处出现`,
  );
  return { ok, lines };
}

// ---------------------------------------------------------------------------
// 审计：把改写过的源码「逆变换」回字面量，与 git HEAD 版本逐字节比对
// ---------------------------------------------------------------------------

/**
 * `--audit`：反向替换证明（本地一次性验证，**不进** `npm run verify`）。
 *
 * 做法：对每个被改写的文件，把新增的那行 import 拿掉、把所有 `CLS.t` 逆变换回
 * 原字面量，然后与 `git show <ref>:<path>` 的内容**逐字节比对**。
 * 完全相等 = 这次改写只动了「类名怎么写」，一行别的代码都没碰。
 *
 * 为什么这条证明比截图比对更硬：截图只覆盖被拍到的视图；逆变换覆盖**全部**
 * 960 处替换，且任何一个字符的错位都会立刻显示成 diff。
 *
 * **它必须在 `--write` 之后、任何人工改动之前跑**：比对基准是 ref 里的版本，
 * 一旦有人再手改这些文件（比如 T1-b 改 App.tsx），差值里就混进了真实的功能改动，
 * 这条断言自然不再成立 —— 那不是回归，是它完成了自己的使命。
 * 想复核当时的结论：`node scripts/tokenize-classes.mjs --audit <token 化之前的 ref>`。
 *
 * 之所以不进 `verify`：它依赖 git 历史（新克隆的浅仓库 / 已提交后的工作区都会失去
 * 比对对象），放进门禁会让「提交之后就永远红」。它是发版前的一次性证据。
 *
 * @param {string} repoRoot git 仓库根
 * @param {string} [ref] 比对基准（默认 HEAD）
 * @returns {number} 退出码
 */
export function runAudit(repoRoot, ref = 'HEAD') {
  const table = readTable();
  if (!table) {
    console.error('✗ 找不到 src/lib/classTokens.ts');
    return 1;
  }
  const valueByToken = new Map(table.map((e) => [e.token, e.value]));
  const files = collectSources();
  let checked = 0;
  let mismatched = 0;

  // 本仓部分文件的**工作区版本**是 CRLF，而 `git show` 给出的是库里存的 LF。
  // 比对前统一折成 LF，否则这层差异会被误报成「改写动了别的代码」。
  const nl = (s) => s.replace(/\r\n/g, '\n');

  for (const file of files) {
    const relPath = relative(repoRoot, file).split(sep).join('/');
    const headRaw = gitShow(repoRoot, `${ref}:${relPath}`);
    if (headRaw === null) continue;
    const head = nl(headRaw);
    const cur = nl(readFileSync(file, 'utf8'));
    if (cur === head) {
      checked += 1;
      continue;
    }
    // 逆变换：摘掉新增 import 行 + CLS.t 还原成字面量
    let recon = cur.replace(/^import \{ CLS \} from '[^']*';\n/m, '');
    recon = recon.replace(/className=\{CLS\.([A-Za-z][A-Za-z0-9]*)\}/g, (_m, t) => {
      const v = valueByToken.get(t);
      return v === undefined ? _m : `className="${v}"`;
    });
    recon = recon.replace(/\bCLS\.([A-Za-z][A-Za-z0-9]*)\b/g, (_m, t) => {
      const v = valueByToken.get(t);
      return v === undefined ? _m : `'${v}'`;
    });
    checked += 1;
    if (recon !== head) {
      mismatched += 1;
      console.error(`  ✗ 逆变换不等：${relPath}`);
      const a = recon.split('\n');
      const b = head.split('\n');
      for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        if (a[i] !== b[i]) {
          console.error(`      第 ${i + 1} 行`);
          console.error(`        逆变换: ${String(a[i]).slice(0, 160)}`);
          console.error(`        HEAD  : ${String(b[i]).slice(0, 160)}`);
          break;
        }
      }
    }
  }

  if (mismatched === 0) {
    console.log(`✓ 逆变换比对：${checked} 个源文件逐一还原后与 git ${ref} 逐字节相同`);
    console.log('  → 改写只改了「类名怎么写」，其他代码一行未动');
    return 0;
  }
  console.error(`\n✗ ${mismatched} 个文件的逆变换结果与 HEAD 不一致`);
  return 1;
}

/**
 * 取 `git show <spec>` 的内容（找不到返回 null）。
 *
 * @param {string} cwd
 * @param {string} spec
 * @returns {string | null}
 */
function gitShow(cwd, spec) {
  try {
    return execFileSync('git', ['show', spec], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * 把「值已经不在新表里」的 `CLS.<token>` 还原成字面量。
 *
 * 为什么必须有这一步：`rewriteFile` 只处理源码里的**字面量**，从不看已经写好的
 * `CLS.x`。于是某个串值掉出表之后，它的 token 会被释放、进而分给新串，而旧代码里
 * 的 `CLS.x` 一个字符都没动 —— 运行时静默换了类名。
 *
 * v1.0.0 真实翻车过：`card` 掉出表后 token `v` 被分给 `chip-toggle`，今日视图、
 * 复盘页、迁移失败页共 29 处 `<section class="card">` 变成了小药丸，而 1473 条测试
 * 与三道门禁全绿（它们都不校验 token 的语义）。
 *
 * 规则：用**旧表**把 token 解析成值，再按**新表**决定写回什么 ——
 * 值还在新表里就写成新 token，不在了就写成字面量。这样 token 复用也不再危险。
 *
 * @param {string} src
 * @param {Array<{token: string, value: string}>} oldTable 本次改写前的表
 * @param {Map<string, string>} tokenByValue 新表（值 → token）
 * @returns {{ next: string, changed: number, detokenized: string[] }}
 */
export function detokenizeStale(src, oldTable, tokenByValue) {
  let next = src;
  let changed = 0;
  /** @type {string[]} */
  const detokenized = [];
  for (const { token, value } of oldTable) {
    const fresh = tokenByValue.get(value);
    if (fresh === token) continue; // 没变，一格不动
    const braced = new RegExp(`\\{CLS\\.${token}\\}`, 'g');
    const bare = new RegExp(`\\bCLS\\.${token}\\b`, 'g');
    if (!braced.test(next) && !bare.test(next)) continue;
    // 先处理 JSX 形态 {CLS.x}（否则会被下面的裸 token 规则拦腰截断）
    if (fresh) {
      next = next.replace(new RegExp(`\\{CLS\\.${token}\\}`, 'g'), `{CLS.${fresh}}`);
      next = next.replace(new RegExp(`\\bCLS\\.${token}\\b`, 'g'), `CLS.${fresh}`);
    } else {
      next = next.replace(new RegExp(`\\{CLS\\.${token}\\}`, 'g'), `"${value}"`);
      next = next.replace(new RegExp(`\\bCLS\\.${token}\\b`, 'g'), `'${value}'`);
      detokenized.push(value);
    }
    changed += 1;
  }
  return { next, changed, detokenized };
}

/**
 * 文件里已经不再使用 `CLS.` 时，把 import 行去掉（否则类型检查会报未使用）。
 *
 * @param {string} src
 * @returns {string}
 */
export function stripUnusedClsImport(src) {
  if (/\bCLS\./.test(src)) return src;
  return src.replace(/^import \{ CLS \} from '[^']*';\r?\n/m, '');
}

/**
 * `--write`：生成表 + 改写源文件。
 *
 * @returns {void}
 */
export function runWrite() {
  const files = collectSources();
  const existing = readTable() ?? [];
  const { counts } = collectCounts(existing, files);
  const plan = stablePlan(planTable(counts), existing);
  /** @type {Map<string, string>} */
  const tokenByValue = new Map(plan.map((e) => [e.value, e.token]));

  writeFileSync(TABLE_FILE, renderTable(plan), 'utf8');
  console.log(`✓ 写出 src/lib/classTokens.ts（${plan.length} 条）`);

  let changedFiles = 0;
  let changedSites = 0;
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    // ★ 先把「值已掉出表」的 CLS.x 还原成字面量，再做常规改写（v1.0.0 回归的根因）
    const { next: deTok, changed: deTokChanged, detokenized } = detokenizeStale(src, existing, tokenByValue);
    const { next: rewritten, changed } = rewriteFile(deTok, tokenByValue);
    const next = stripUnusedClsImport(rewritten);
    if (changed === 0 && deTokChanged === 0) continue;
    const line = `import { CLS } from '${importSpecifierFor(file)}';`;
    const withImport = /\bCLS\./.test(next) ? insertImport(next, line) : next;
    writeFileSync(file, withImport, 'utf8');
    changedFiles += 1;
    changedSites += changed;
    if (detokenized.length > 0) {
      console.log(`  · ${relative(SRC_ROOT, file).split(sep).join('/')} 还原字面量：${[...new Set(detokenized)].join('、')}`);
    }
  }
  console.log(`✓ 改写 ${changedFiles} 个源文件，共 ${changedSites} 处`);

  // 黄金副本**不**自动重录（自动重录 = 断言 6 失效）。只在它还不存在时补一份，
  // 让「新克隆仓库 + 首次 --write」能跑通；已存在则提醒人工确认。
  if (!readGolden()) {
    writeFileSync(GOLDEN_FILE, renderGolden(plan), 'utf8');
    console.log('✓ 黄金副本不存在，已按本次结果录制 src/lib/classTokens.golden.json');
  } else {
    console.log('  · 黄金副本未改动：若本次改表是有意的，请跑 --golden 重录，否则 --check 会红');
  }
}

/**
 * `--stats`：只打印统计。
 *
 * @returns {void}
 */
export function runStats() {
  const files = collectSources();
  const existing = readTable() ?? [];
  const { counts, occurrences } = collectCounts(existing, files);
  const ranked = [...counts.entries()]
    .filter(([, n]) => n > 0)
    .map(([value, count]) => ({ value, count, score: netGain(value, count, 2) }))
    .sort((a, b) => b.score - a.score || b.count - a.count);

  console.log(`源文件 ${files.length} 个；串值 ${ranked.length} 个；出现处 ${occurrences} 处`);
  const top = ranked.slice(0, 100);
  console.log(`Top100 覆盖 ${top.reduce((s, r) => s + r.count, 0)} 处`);
  console.log('前 15：');
  for (const r of ranked.slice(0, 15)) {
    console.log(`  ×${String(r.count).padStart(3)}  ${r.value}  (score ${r.score})`);
  }
}

/**
 * CLI 入口。
 *
 * @returns {number} 进程退出码
 */
export function main(argv = process.argv.slice(2)) {
  const mode = argv.find((a) => a.startsWith('--')) ?? '--check';

  if (mode === '--write') {
    runWrite();
    return 0;
  }
  if (mode === '--golden') {
    runGolden();
    return 0;
  }
  if (mode === '--stats') {
    runStats();
    return 0;
  }
  if (mode === '--audit') {
    return runAudit(resolve(here, '..', '..'), argv.find((a) => !a.startsWith('--')) ?? 'HEAD');
  }
  if (mode !== '--check') {
    console.error(`✗ 未知参数：${mode}`);
    console.error('  用法：tokenize-classes.mjs [--check | --write | --golden | --stats | --audit [ref]]');
    return 2;
  }

  const { ok, lines } = runCheck();
  for (const l of lines) console.log(l);
  if (!ok) {
    console.error('\n✗ 类名 token 化校验失败');
    console.error('  修法：node scripts/tokenize-classes.mjs --write（生成/更新表并改写源码）');
    return 1;
  }
  return 0;
}

// 直接执行时才跑 CLI（被测试 import 时不跑）
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
