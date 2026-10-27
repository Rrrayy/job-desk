#!/usr/bin/env node
/**
 * 发 GitHub Release（v0.9.1 / R-REL-1，架构 B-14）。
 *
 * ## 为什么是「默认演练、显式 --confirm 才真发」
 *
 * 发版是**不可逆的对外动作**：Release 一旦发出去，下载链接就会被别人拿到，
 * 附件删掉也收不回已经下载的副本。所以这个脚本的默认行为必须是什么都不发 ——
 * 只把「将要发出哪些请求」逐条打印出来，让人看一眼再决定。
 *
 * ## 为什么只支持 NEW，不支持「补发 / 改附件」（架构 Q8）
 *
 * GitHub 的 `PATCH /releases/:id` 能改标题、正文、附件（要先删再传）。
 * 支持它意味着「一个已有 Release 的内容会在某次重跑后变样」，而本项目对外承诺
 * 「同样的输入产出同样的产物」（`pack-release.mjs` 连 ZIP 时间戳都固定）。
 * 与其做半套（补发算新版本还是覆盖？覆盖后旧附件的下载链接还好不好使？），
 * 不如明确拒绝：**tag 已存在 → 直接报错退出，让人自己决定怎么处理**。
 *
 * ## token 从哪来
 *
 * 只从环境变量 `GITHUB_TOKEN` 读，**不读文件、不收命令行参数**：
 * 命令行参数会进 shell 历史、进 CI 日志；文件会被误提交。
 * 缺了就退出码 1（不是「问一下」——非交互环境下问就是挂住）。
 *
 * ## 为什么不进 `npm run verify`
 *
 * `verify` 每次提交都要跑，而它要联网、要真 token、会创建 Release。
 * 它挂在 `release:github` 上，只在人显式发版时调用。
 *
 * 用法：
 *   node scripts/release-publish.mjs                # 演练（默认）
 *   GITHUB_TOKEN=... node scripts/release-publish.mjs --confirm
 *   node scripts/release-publish.mjs --tag v0.9.1 --confirm
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:https';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = resolve(APP_DIR, '..');
const DEFAULT_REPO = 'Rrrayy/job-desk';

/**
 * 解析命令行参数。
 *
 * 支持：`--confirm`（真发）、`--tag v0.9.1`（默认取 app/package.json 的版本）、
 * `--repo owner/name`（默认本仓）。任何未知参数都报错 —— 打错一个字母就静默跑
 * 默认行为，是发版脚本最危险的一类故障。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{ ok: true, confirm: boolean, tag: string | null, repo: string } | { ok: false, error: string }}
 */
export function parseArgs(argv) {
  let confirm = false;
  /** @type {string | null} */
  let tag = null;
  let repo = DEFAULT_REPO;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--confirm') {
      confirm = true;
      continue;
    }
    if (arg === '--tag') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) return { ok: false, error: '--tag 后面要跟版本号，例如 --tag v0.9.1' };
      tag = next;
      i += 1;
      continue;
    }
    if (arg === '--repo') {
      const next = argv[i + 1];
      if (!next || !/^[\w.-]+\/[\w.-]+$/.test(next)) return { ok: false, error: '--repo 要写成 owner/name' };
      repo = next;
      i += 1;
      continue;
    }
    return { ok: false, error: `未知参数：${arg}（只支持 --confirm / --tag / --repo）` };
  }
  return { ok: true, confirm, tag, repo };
}

/**
 * 读 token。只看环境变量，缺了返回 null（调用方据此退出 1）。
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
export function findToken(env) {
  const token = (env.GITHUB_TOKEN ?? '').trim();
  return token.length > 0 ? token : null;
}

/**
 * 列出 `release/<tag>/` 下的发布资产。
 *
 * @param {string} dir 资产目录
 * @returns {Array<{ name: string, path: string, size: number }>} 按文件名排序（保证请求顺序可复现）
 */
export function listAssets(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((name) => ({ name, path: join(dir, name) }))
    .filter((entry) => statSync(entry.path).isFile())
    .map((entry) => ({ ...entry, size: statSync(entry.path).size }));
}

/**
 * 生成「将要发出的请求」清单（**纯函数，不发网络**）。
 *
 * 这是整个脚本唯一有判断逻辑的地方：所有拒绝都在这里返回，`main` 只负责打印与执行。
 * `steps` 里永远不会出现 PATCH / PUT / DELETE —— 这是 Q8 裁决的硬约束：
 * 本脚本只创建新 Release、只上传新附件。
 *
 * @param {object} input
 * @param {string | null} input.token GITHUB_TOKEN
 * @param {boolean} input.confirm 用户是否显式确认
 * @param {string} input.tag 目标 tag
 * @param {string} input.repo owner/name
 * @param {boolean} input.tagExists 远端（或本地）是否已有这个 tag
 * @param {Array<{ name: string, path: string, size: number }>} input.assets 发布资产
 * @param {string} input.expectedDir 期望的资产目录（报错时告诉人去哪找）
 * @returns {{ ok: boolean, code: number, mode: 'dry-run' | 'publish', messages: string[], steps: Array<{ method: string, path: string, note: string }> }}
 */
export function buildPlan(input) {
  const { token, confirm, tag, repo, tagExists, assets, expectedDir } = input;
  /** @type {string[]} */
  const messages = [];
  /** @type {Array<{ method: string, path: string, note: string }>} */
  const steps = [];
  const done = (ok, code, mode) => ({ ok, code, mode, messages, steps });

  if (assets.length === 0) {
    messages.push(`✗ 没找到发布资产：${expectedDir}`);
    messages.push('  先跑 npm run release:prep（会构建、打包并生成 SHA256SUMS）');
    return done(false, 1, 'dry-run');
  }
  const hasHtml = assets.some((asset) => asset.name === 'index.html');
  const hasSums = assets.some((asset) => asset.name === 'SHA256SUMS');
  if (!hasHtml || !hasSums) {
    messages.push(`✗ 资产不完整（需要 index.html 与 SHA256SUMS，实际：${assets.map((a) => a.name).join('、')}）`);
    messages.push('  先把 npm run release:pack 跑完');
    return done(false, 1, 'dry-run');
  }
  if (tagExists) {
    messages.push(`✗ tag ${tag} 已存在 —— 本脚本只发新 Release，不支持补发或改附件（架构 Q8）`);
    messages.push('  想重发请先自行处理旧 Release（本脚本不会替你删任何东西）');
    return done(false, 1, 'dry-run');
  }
  if (!token) {
    messages.push('✗ 没有找到 GITHUB_TOKEN 环境变量');
    messages.push('  设置方式：export GITHUB_TOKEN=ghp_xxx（只读环境变量，不接受命令行参数）');
    return done(false, 1, 'dry-run');
  }

  steps.push({
    method: 'POST',
    path: `/repos/${repo}/releases`,
    note: `创建 Release ${tag}（draft=false，标题与正文留空由人补）`,
  });
  for (const asset of assets) {
    steps.push({
      method: 'POST',
      // ★ 资产上传必须走 uploads.github.com —— api.github.com 的同名路径只接受 GET，
      //   POST 一律 404。v0.9.1 首发实测抓到的 bug：演练模式当时只核对 path 不核对 host。
      host: 'uploads.github.com',
      path: `/repos/${repo}/releases/:id/assets?name=${encodeURIComponent(asset.name)}`,
      note: `上传 ${asset.name}（${asset.size} B）`,
    });
  }

  if (!confirm) {
    messages.push(`演练模式：以下 ${steps.length} 个请求**没有发出**。确认无误后加 --confirm。`);
    return done(true, 0, 'dry-run');
  }
  messages.push(`即将发布 ${tag}：${steps.length} 个请求`);
  return done(true, 0, 'publish');
}

/**
 * 发一个 HTTPS 请求（真实网络；测试里通过 `sender` 注入替身，不会真发）。
 *
 * @param {object} options
 * @param {string} options.method
 * @param {string} options.path 形如 `/repos/o/n/releases`
 * @param {string} options.token
 * @param {Buffer} [options.body]
 * @param {string} [options.contentType]
 * @returns {Promise<{ status: number, body: string }>}
 */
export function httpsSend(options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request(
      {
        hostname: options.host ?? 'api.github.com',
        path: options.path,
        method: options.method,
        headers: {
          // GitHub 要求 User-Agent；缺了直接 403
          'user-agent': 'job-desk-release-script',
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${options.token}`,
          'x-github-api-version': '2022-11-28',
          ...(options.body
            ? { 'content-type': options.contentType ?? 'application/json', 'content-length': options.body.length }
            : {}),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', rejectPromise);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * 判断 tag 是否已存在。用 `git tag --list` 查本地（发版机必然有 tag），
 * 不额外打 GitHub API —— 少一个需要网络的判断，演练模式才能完全离线。
 *
 * @param {string} tag
 * @param {(args: string[]) => string} run 执行 git 的注入点（测试里替身）
 * @returns {boolean}
 */
export function tagExists(tag, run) {
  try {
    return run(['tag', '--list', tag]).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * CLI 主流程。
 *
 * @param {string[]} argv
 * @param {object} [io] 注入点（测试用）
 * @param {Record<string, string | undefined>} [io.env]
 * @param {(options: object) => Promise<{ status: number, body: string }>} [io.sender]
 * @param {(lines: string[]) => void} [io.print]
 * @param {(lines: string[]) => void} [io.printErr]
 * @param {(args: string[]) => string} [io.runGit]
 * @param {string} [io.version]
 * @param {string} [io.dir] 资产目录（默认 `release/<tag>`；测试注入临时目录）
 * @returns {Promise<number>} 退出码
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const print = io.print ?? ((lines) => lines.forEach((line) => console.log(line)));
  const printErr = io.printErr ?? ((lines) => lines.forEach((line) => console.error(line)));
  const sender = io.sender ?? httpsSend;

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    printErr([`✗ ${parsed.error}`]);
    return 2;
  }

  const tag = parsed.tag ?? `v${io.version ?? readVersion()}`;
  const dir = io.dir ?? join(REPO_DIR, 'release', tag);
  const assets = listAssets(dir);
  const runGit =
    io.runGit ?? ((args) => execFileSync('git', args, { cwd: REPO_DIR, encoding: 'utf8' }));
  const exists = tagExists(tag, runGit);

  const plan = buildPlan({
    token: findToken(env),
    confirm: parsed.confirm,
    tag,
    repo: parsed.repo,
    tagExists: exists,
    assets,
    expectedDir: dir,
  });

  if (!plan.ok) {
    printErr(plan.messages);
    return plan.code;
  }

  print(plan.messages);
  for (const step of plan.steps) print([`  ${step.method} https://${step.host ?? 'api.github.com'}${step.path}`, `    ${step.note}`]);
  if (plan.mode === 'dry-run') return 0;

  // ---- 真发：一条一条来，失败即停（不做「部分成功」的花活） ----
  const releaseRes = await sender({
    method: 'POST',
    path: `/repos/${parsed.repo}/releases`,
    token: findToken(env) ?? '',
    body: Buffer.from(
      JSON.stringify({
        tag_name: tag,
        name: tag,
        draft: false,
        prerelease: false,
        body: '产物为单文件 index.html，双击即用。校验和见 SHA256SUMS。',
      }),
    ),
  });
  if (releaseRes.status < 200 || releaseRes.status >= 300) {
    printErr([`✗ 创建 Release 失败（HTTP ${releaseRes.status}）`, releaseRes.body.slice(0, 400)]);
    return 1;
  }
  let releaseId;
  try {
    releaseId = JSON.parse(releaseRes.body).id ?? 0;
  } catch {
    releaseId = 0;
  }
  if (!releaseId) {
    printErr(['✗ Release 已创建但响应里没有 id —— 附件无法上传，请到网页上手动补']);
    return 1;
  }
  print([`✓ Release ${tag} 已创建（id=${releaseId}），开始上传 ${assets.length} 个附件`]);

  for (const asset of assets) {
    const upload = await sender({
      method: 'POST',
      host: 'uploads.github.com',
      path: `/repos/${parsed.repo}/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`,
      token: findToken(env) ?? '',
      body: readFileSync(asset.path),
      contentType: 'application/octet-stream',
    });
    if (upload.status < 200 || upload.status >= 300) {
      printErr([`✗ 上传 ${asset.name} 失败（HTTP ${upload.status}）`, upload.body.slice(0, 400)]);
      return 1;
    }
    print([`  ✓ ${asset.name}`]);
  }
  print([`✓ 发布完成：${tag}`]);
  return 0;
}

/** 读 app/package.json 的版本（tag 的默认来源） */
function readVersion() {
  return JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')).version;
}

// 直接执行时才跑 CLI（被测试 import 时不跑）
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
