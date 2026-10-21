/**
 * 测试启动器。
 *
 * 为什么不用 `vitest run` 直接当 npm test：两件事会让「测试全过但 CI 红」。
 *
 * ① **临时目录写不进去**：vitest 的 worker 会把转换后的模块写进 `os.tmpdir()`。
 *    在沙箱 / 企业安全软件 / 只读 TEMP 的机器上，这个写入会抛 EPERM，
 *    vitest 把它当成 unhandled error，退出码变成 1。
 *    对策：启动前挑一个**真的能异步写入**的目录，设成 TMP/TEMP/TMPDIR，
 *    再在新进程里启动 vitest（libuv 会缓存 os.tmpdir()，必须在进程启动时就设好）。
 *
 * ② **并发写**：worker 会并发写同一批缓存文件，受限环境下偶发 EPERM。
 *    对策：默认 `--no-file-parallelism`（本仓库 11 个纯函数测试文件，串行 1~2 秒）。
 *    想恢复并发：`PARALLEL=1 npm test`。
 *
 * 这个脚本零依赖、跨平台（win/mac/linux 都能跑），不改变任何测试语义。
 */

import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const localTmp = resolve(appRoot, 'node_modules/.tmp');

/**
 * 能建目录 + 能**异步**写文件 + 能删，才算可用。
 * 故意用 fs/promises：vitest 走的是异步写入路径，某些沙箱会拦异步写入但放行同步写入，
 * 用 writeFileSync 探测会得到「看起来能用、跑起来 EPERM」的假阳性。
 */
async function usable(dir) {
  try {
    await mkdir(dir, { recursive: true });
    const probe = join(dir, `.probe-${process.pid}.tmp`);
    await writeFile(probe, 'ok');
    await rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 候选临时目录：系统临时目录优先（正常机器上最合适），
 * 写不进去再退到项目内 `node_modules/.tmp`（不受系统 TEMP 权限影响）。
 * 两个都不行就用系统默认，让 vitest 自己报错 —— 不伪装成「测试失败」。
 */
let chosenTmp = tmpdir();
for (const candidate of [tmpdir(), localTmp]) {
  if (await usable(candidate)) {
    chosenTmp = candidate;
    break;
  }
}

try {
  mkdirSync(chosenTmp, { recursive: true });
} catch {
  // 交给 vitest：它会在 stderr 里说清楚哪里写不进去
}

/** @type {NodeJS.ProcessEnv} */
const env = {
  ...process.env,
  TMPDIR: chosenTmp,
  TMP: chosenTmp,
  TEMP: chosenTmp,
};

console.log(`[test] 临时目录：${chosenTmp}`);

const extraArgs = process.argv.slice(2);
const vitestBin = resolve(appRoot, 'node_modules/vitest/vitest.mjs');

/**
 * 默认串行跑测试文件。
 *
 * 理由：vitest 的 worker 会把转换后的模块**并发**写进 `<临时目录>/<项目 id>/ssr/`。
 * 在沙箱 / 企业安全软件 / 只读 TEMP 的机器上，这类并发写会偶发 EPERM，
 * vitest 把它算成 unhandled error 并把退出码变成 1 —— 测试全过，但 CI 红。
 * 这个仓库只有 11 个纯函数测试文件，串行也只要 1~2 秒，用确定性换这点时间很值。
 *
 * 想恢复并发：`PARALLEL=1 npm test`。
 */
const args = process.env.PARALLEL === '1' ? ['run', ...extraArgs] : ['run', '--no-file-parallelism', ...extraArgs];

const child = spawn(process.execPath, [vitestBin, ...args], {
  cwd: appRoot,
  env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error('启动 vitest 失败：', error.message);
  process.exit(1);
});
