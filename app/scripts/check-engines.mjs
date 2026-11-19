/**
 * Node 版本下界核对器。
 *
 * ## 为什么要有这个东西
 *
 * 2026-11 那轮排查里发现：CI 已经红了 21 次，而**两档 Node 都必红**。
 * 原因不是测试写错了，是判据本身坏了 —— `app/package.json` 写着 `engines.node: ">=18"`，
 * 可装上来的两个工具链都不支持 18：
 *
 *   jsdom@30      `^22.22.2 || ^24.15.0 || >=26.0.0`   ← 连 node 20 都不满足
 *   eslint@10     `^20.19.0 || ^22.13.0 || >=24`       ← node 18 不满足
 *
 * 而且失败长得极像「测试挂了」：jsdom 在构造阶段就崩，所有 `.tsx` 测试在挂载 React
 * 之前就报错，表现为「单测 17 秒就红」（本地全量 198 秒）。光看日志根本猜不到是环境。
 *
 * 这类事故的普遍形态是：**依赖升上去了，`engines` 没跟着抬，CI 矩阵也没跟着抬。**
 * 三者只要有一处不一致，红的永远是第三方那一处，而人只会去翻自己的代码。
 *
 * ## 它检查什么
 *
 * 拿 `package.json` 的 `engines.node` 算出**下界版本**，然后逐个核对 `node_modules` 里
 * 每个包自己声明的 `engines.node` 是否接受这个下界。任何一个包不接受 → 退出码 1，
 * 并打印「哪个包、要什么范围」。所有包都接受 → 说明 `engines.node` 这句话没有撒谎。
 *
 * 也可以手动指定版本核对：
 *
 *   node scripts/check-engines.mjs            # 核对 engines.node 的下界（默认）
 *   node scripts/check-engines.mjs 18.20.8    # 核对「如果我要支持 node 18 会怎样」
 *
 * ## 边界
 *
 * - 只看**顶层** `node_modules`（npm 会提升，实际解析树绝大多数在这一层）。
 *   嵌套 `node_modules` 里的副本不扫 —— 它们是被上面某个包钉死的，改了也没用。
 * - 自己实现了一个极小的 semver 子集（`>=` / `>` / `<=` / `<` / `^` / `~` / 裸版本 / `||` / 空格与），
 *   不引入 `semver` 包。理由和 `run-tests.mjs` 一样：构建链不加依赖，
 *   而且 `semver` 在本仓库只是 vite 的传递依赖，靠它等于靠一个我们没声明的包。
 *   这个子集覆盖了 npm 生态里 engines.node 的常见写法；遇到不认识的写法**不猜**，
 *   当作「不认识」直接报出来，不静默放过。
 *
 * 自测在 `check-engines.test.mjs`，被 `vitest.config.ts` 的 `scripts/**\/*.test.mjs`
 * 收进 `npm test` —— 所以这条保障会跟着每次 `npm test` 一起跑，不靠人记得手动执行。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');

/* ============================ 极小 semver 子集 ============================ */

/** `v22.22.2` / `22.22` / `22` → `[22,22,2]` / `[22,22,0]` / `[22,0,0]`；认不出返回 null */
export function parseVersion(text) {
  const match = /^[v=\s]*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(text).trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** 单个比较符。返回 true / false；遇到不认识的写法返回 'unknown'（不静默放过） */
function testComparator(version, token) {
  const text = token.trim();
  if (!text || text === '*' || text === 'x' || text === 'X') return true;

  const operator = /^(>=|<=|>|<|=|\^|~)/.exec(text)?.[1] ?? '';
  const rest = operator ? text.slice(operator.length) : text;
  const bound = parseVersion(rest);
  if (!bound) return 'unknown';

  switch (operator) {
    case '>=':
      return compare(version, bound) >= 0;
    case '>':
      return compare(version, bound) > 0;
    case '<=':
      return compare(version, bound) <= 0;
    case '<':
      return compare(version, bound) < 0;
    case '^':
      // ^22.22.2 → >=22.22.2 <23.0.0
      return compare(version, bound) >= 0 && version[0] === bound[0];
    case '~':
      // ~22.22.2 → >=22.22.2 <22.23.0
      return compare(version, bound) >= 0 && version[0] === bound[0] && version[1] === bound[1];
    default: {
      // 裸版本。"20" 表示 20.x 任意补丁，"20.19" 表示 20.19.x，"20.19.5" 精确相等。
      if (/^\d+$/.test(text)) return version[0] === bound[0];
      if (/^\d+\.\d+$/.test(text)) return version[0] === bound[0] && version[1] === bound[1];
      return compare(version, bound) === 0;
    }
  }
}

/** `>= 18` / `^ 1.2` 这类「操作符与版本之间有空格」的写法先粘回去，否则会被空格切分成两个 token */
function normalizeRange(range) {
  return String(range).replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1');
}

/**
 * 判断 `version` 是否被 `range` 接受。
 * 支持 `||` 分隔的多段（任一满足即可）与空格分隔的比较符（全部满足）。
 * 返回 true / false；range 里出现不认识的写法时返回 'unknown'。
 */
export function satisfies(version, range) {
  const parsed = parseVersion(version);
  if (!parsed) return false;

  const alternatives = normalizeRange(range)
    .split('||')
    .map((part) => part.trim())
    .filter(Boolean);
  if (alternatives.length === 0) return true;

  let sawUnknown = false;
  for (const alternative of alternatives) {
    const tokens = alternative.split(/\s+/).filter(Boolean);
    let allTrue = true;
    for (const token of tokens) {
      const result = testComparator(parsed, token);
      if (result === 'unknown') sawUnknown = true;
      if (result !== true) {
        allTrue = false;
        break;
      }
    }
    if (allTrue) return true;
  }
  return sawUnknown ? 'unknown' : false;
}

/**
 * 算出一段 range 的**下界**（能被接受的最低版本）。
 * 用于从 `engines.node: "^22.22.2 || ^24.15.0 || >=26"` 得到 `22.22.2`。
 * 只取下界，忽略上界 —— 我们要问的是「最低能跑多低」。
 */
export function lowerBound(range) {
  const alternatives = normalizeRange(range)
    .split('||')
    .map((part) => part.trim())
    .filter(Boolean);

  let best = null;
  for (const alternative of alternatives) {
    const tokens = alternative.split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      const text = token.trim();
      if (/^(<|<=)/.test(text)) continue; // 上界，与下界无关
      const version = parseVersion(text.replace(/^[\^~>=]+/, ''));
      if (!version) continue;
      if (!best || compare(version, best) < 0) best = version;
    }
  }
  return best;
}

/* ============================ 采集与核对 ============================ */

/** 读出顶层 node_modules 里每个包自己声明的 engines.node */
export function collectEngineRanges(nodeModulesDir) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(nodeModulesDir);
  } catch {
    return found;
  }

  const readOne = (dir) => {
    const manifest = join(dir, 'package.json');
    let json;
    try {
      if (!statSync(manifest).isFile()) return;
      json = JSON.parse(readFileSync(manifest, 'utf-8'));
    } catch {
      return;
    }
    const range = json.engines?.node;
    if (!range) return;
    found.push({ name: json.name ?? dir, version: json.version ?? '0.0.0', range: String(range) });
  };

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const full = join(nodeModulesDir, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    if (entry.startsWith('@')) {
      let scoped;
      try {
        scoped = readdirSync(full);
      } catch {
        continue;
      }
      // 点开头的也要跳：npm 安装中断会留下 `.css-color-2S7DUR5e` 这种暂存目录，
      // 里面是**完整的一份旧包**，不跳过就会把同一个包算两遍、甚至算成旧版本。
      for (const child of scoped) {
        if (child.startsWith('.')) continue;
        readOne(join(full, child));
      }
    } else {
      readOne(full);
    }
  }
  return found;
}

/** 哪些包不接受 `version`。`unknown` 的写法单列，不混进 offenders 也不被吞掉 */
export function findOffenders(packages, version) {
  const offenders = [];
  const unknown = [];
  for (const item of packages) {
    const verdict = satisfies(version, item.range);
    if (verdict === 'unknown') unknown.push(item);
    else if (verdict === false) offenders.push(item);
  }
  return { offenders, unknown };
}

/* ============================ CLI ============================ */

function main() {
  const pkgPath = join(appRoot, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const declared = pkg.engines?.node;
  const nodeModulesDir = join(appRoot, 'node_modules');

  if (!declared) {
    console.error('check-engines：package.json 里没有 engines.node —— 等于没声明下界，请先补上');
    process.exit(1);
  }

  const floor = lowerBound(declared);
  if (!floor) {
    console.error(`check-engines：无法从 engines.node = "${declared}" 解析出下界版本`);
    process.exit(1);
  }
  const floorText = floor.join('.');

  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const targets = requested.length > 0 ? requested : [floorText];

  const packages = collectEngineRanges(nodeModulesDir);
  if (packages.length === 0) {
    console.error(`check-engines：${nodeModulesDir} 里没有找到任何声明 engines.node 的包，先 npm install`);
    process.exit(1);
  }

  console.log(`check-engines：engines.node = "${declared}"，下界 ${floorText}`);
  console.log(`check-engines：扫描 ${packages.length} 个声明了 engines.node 的包`);

  let failed = false;
  for (const target of targets) {
    const { offenders, unknown } = findOffenders(packages, target);
    if (offenders.length === 0) {
      console.log(`  ✓ ${target}：全部接受`);
    } else {
      failed = true;
      console.error(`  ✗ ${target}：${offenders.length} 个包不接受，engines.node 这句话在撒谎`);
      for (const item of offenders) {
        console.error(`      ${item.name}@${item.version}  需要 ${item.range}`);
      }
      console.error('    改法二选一：把 engines.node 与 CI 矩阵抬到真实下界，或把这些依赖降到支持该版本。');
      console.error('    不要只改一处 —— 那就是 2026-11 连红 21 次的原因。');
    }
    if (unknown.length > 0) {
      console.log(`  · ${target}：${unknown.length} 个包的版本范围本工具不认识，未判定`);
      for (const item of unknown) console.log(`      ${item.name}@${item.version}  ${item.range}`);
    }
  }

  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
