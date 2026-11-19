/**
 * `check-engines.mjs` 的自测。
 *
 * 它存在的理由只有一个：**2026-11 那次 CI 连红 21 次，如果有人早写了这个文件，第 1 次就红了。**
 *
 * 事故形态回顾：`app/package.json` 写着 `engines.node: ">=18"`，CI 矩阵写着 `['18','20']`，
 * 而装上来的 `jsdom@30` 要 `^22.22.2 || ^24.15.0 || >=26`、`eslint@10` 要
 * `^20.19.0 || ^22.13.0 || >=24`。于是两档 Node 都必红，而红的日志长得像「测试挂了」，
 * 所有人都在自己的代码里找问题，找了 21 轮。
 *
 * 所以这里除了单元级的边界，最要紧的是两条**针对真实仓库的**断言：
 *   ① 真实 `node_modules` 里没有任何包拒绝 `package.json` 声明的下界（声明没撒谎）；
 *   ② CI 矩阵里每个 Node 主版本都 ≥ 声明的下界主版本（矩阵没测低版本）。
 * 还有一条**反证**：拿 node 18 去核对必须失败 —— 否则说明这个检查永远返回 happy，
 * 等于没有检查（很多门禁是坏的但看上去全绿）。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  collectEngineRanges,
  findOffenders,
  lowerBound,
  parseVersion,
  satisfies,
} from './check-engines.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..');

/** 事故现场的原样范围，直接抄自两个包自己的 package.json */
const JSDOM_RANGE = '^22.22.2 || ^24.15.0 || >=26.0.0';
const ESLINT_RANGE = '^20.19.0 || ^22.13.0 || >=24';

describe('check-engines · 版本比较的最小语义', () => {
  it('parseVersion 认得出主/次/补丁缺省与被 v 前缀', () => {
    expect(parseVersion('22.22.2')).toEqual([22, 22, 2]);
    expect(parseVersion('v22.22.2')).toEqual([22, 22, 2]);
    expect(parseVersion('22.22')).toEqual([22, 22, 0]);
    expect(parseVersion('22')).toEqual([22, 0, 0]);
    expect(parseVersion('not-a-version')).toBeNull();
  });

  it('★ jsdom@30 的真实范围：node 20 与 node 18 都必须被拒绝', () => {
    expect(satisfies('20.19.5', JSDOM_RANGE)).toBe(false);
    expect(satisfies('18.20.8', JSDOM_RANGE)).toBe(false);
  });

  it('★ jsdom@30 的真实范围：下界含、下界减一个补丁不含', () => {
    expect(satisfies('22.22.2', JSDOM_RANGE)).toBe(true);
    expect(satisfies('22.22.1', JSDOM_RANGE)).toBe(false);
    expect(satisfies('22.23.5', JSDOM_RANGE)).toBe(true);
  });

  it('★ jsdom@30 的真实范围：24.15 下界与 >=26 分支', () => {
    expect(satisfies('24.15.0', JSDOM_RANGE)).toBe(true);
    expect(satisfies('24.14.9', JSDOM_RANGE)).toBe(false);
    expect(satisfies('26.0.0', JSDOM_RANGE)).toBe(true);
    expect(satisfies('27.0.0', JSDOM_RANGE)).toBe(true);
  });

  it('★ eslint@10 的真实范围：node 18 拒绝、node 20.19 起接受', () => {
    expect(satisfies('18.20.8', ESLINT_RANGE)).toBe(false);
    expect(satisfies('20.18.9', ESLINT_RANGE)).toBe(false);
    expect(satisfies('20.19.0', ESLINT_RANGE)).toBe(true);
    expect(satisfies('22.13.0', ESLINT_RANGE)).toBe(true);
    expect(satisfies('24.22.3', ESLINT_RANGE)).toBe(true);
  });

  it('裸主版本的写法「20 || >=22」按主版本比', () => {
    expect(satisfies('20.5.0', '20 || >=22')).toBe(true);
    expect(satisfies('21.5.0', '20 || >=22')).toBe(false);
    expect(satisfies('22.0.0', '20 || >=22')).toBe(true);
  });

  it('★ 操作符后带空格（`>= 18`）必须认得出，不能判成 unknown', () => {
    // 真实仓库里有 10 个包写的是 `>= 18` 这种带空格的形态（@keyv/bigmap、cross-spawn、
    // ignore、which…）。曾经它们全部被判成 unknown 静默跳过 —— 检查看上去是绿的，其实没看。
    expect(satisfies('18.20.8', '>= 18')).toBe(true);
    expect(satisfies('17.9.9', '>= 18')).toBe(false);
    expect(satisfies('22.0.0', '>= 14.16')).toBe(true);
  });

  it('下界运算：从真实范围里取出最低可接受版本', () => {
    expect(lowerBound(JSDOM_RANGE)).toEqual([22, 22, 2]);
    expect(lowerBound(ESLINT_RANGE)).toEqual([20, 19, 0]);
    expect(lowerBound('20 || >=22')).toEqual([20, 0, 0]);
    expect(lowerBound('>=18')).toEqual([18, 0, 0]);
  });

  it('认不出的写法返回 unknown，不静默放过', () => {
    expect(satisfies('22.0.0', 'lts/krypton')).toBe('unknown');
  });
});

describe('check-engines · 对真实仓库的断言', () => {
  const pkg = JSON.parse(readFileSync(resolve(appRoot, 'package.json'), 'utf-8'));
  const declared = pkg.engines && pkg.engines.node;
  const floor = declared ? lowerBound(declared) : null;
  const packages = collectEngineRanges(resolve(appRoot, 'node_modules'));

  it('package.json 声明了 engines.node 且能解析出下界', () => {
    expect(declared).toBeTruthy();
    expect(floor).not.toBeNull();
  });

  it('node_modules 里确实扫到了包（扫不到说明检查本身失效了）', () => {
    expect(packages.length).toBeGreaterThan(50);
  });

  it('同一个包只应被扫到一次（npm 暂存目录不得把包算两遍）', () => {
    const seen = new Map();
    for (const item of packages) {
      const key = `${item.name}@${item.version}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    expect([...seen].filter(([, count]) => count > 1)).toEqual([]);
  });

  it('★ 声明没撒谎：没有任何包拒绝 engines.node 的下界', () => {
    expect(floor).not.toBeNull();
    const { offenders } = findOffenders(packages, floor.join('.'));
    // 失败时把是谁、要什么打出来，不然只知道「红了」
    expect(offenders.map((item) => `${item.name}@${item.version} 需要 ${item.range}`)).toEqual([]);
  });

  it('★ 反证：拿 node 18 核对必须失败（证明这条检查不是永远 happy）', () => {
    const { offenders } = findOffenders(packages, '18.20.8');
    expect(offenders.length).toBeGreaterThan(0);
    expect(offenders.some((item) => item.name === 'jsdom')).toBe(true);
  });

  it('★ CI 矩阵不许测低于下界的 Node 主版本', () => {
    const workflow = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf-8');
    const matrix = /^\s*node:\s*\[([^\]]+)\]/m.exec(workflow);
    expect(matrix, 'ci.yml 里找不到 matrix 的 node: [...] 声明').not.toBeNull();

    const versions = matrix[1]
      .split(',')
      .map((part) => parseVersion(part.trim().replace(/['"]/g, '')))
      .filter((item) => item !== null);
    expect(versions.length).toBeGreaterThan(0);

    expect(floor).not.toBeNull();
    const floorMajor = floor[0];
    const tooLow = versions.filter((item) => item[0] < floorMajor).map((item) => item.join('.'));
    expect(tooLow).toEqual([]);
  });
});
