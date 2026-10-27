/**
 * 发布脚本自测（v0.9.1 / R-REL-1）。
 *
 * 发版脚本的自测比业务代码更重要：它跑错一次就会在 GitHub 上留下一个删不掉的历史。
 * 所以这一组不测「能不能发成功」，而是逐条钉住**它必须拒绝什么**：
 *
 * - 没有 `--confirm` → 演练：**一个请求都不发**（`sender` 一次都不许被调）；
 * - 没有 `GITHUB_TOKEN` → 退出码 1（不读文件、不问交互）；
 * - tag 已存在 → 拒绝（Q8：不支持补发，且**永远不发 PATCH**）；
 * - 资产不齐 → 提示先跑打包（而不是发一个只有半个附件的 Release）。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPlan,
  findToken,
  listAssets,
  main,
  parseArgs,
  tagExists,
} from './release-publish.mjs';

const goodAssets = [
  { name: 'SHA256SUMS', path: '/tmp/SHA256SUMS', size: 90 },
  { name: 'index.html', path: '/tmp/index.html', size: 1000 },
];

const repoNames = (steps) => steps.map((step) => step.method);

describe('release-publish · parseArgs', () => {
  it('默认：演练模式、tag 由版本推出、repo 默认本仓', () => {
    const parsed = parseArgs([]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.confirm).toBe(false);
    expect(parsed.tag).toBeNull();
    expect(parsed.repo).toBe('Rrrayy/job-desk');
  });

  it('--confirm / --tag / --repo 都能解析', () => {
    const parsed = parseArgs(['--confirm', '--tag', 'v0.9.1', '--repo', 'me/fork']);
    expect(parsed).toMatchObject({ ok: true, confirm: true, tag: 'v0.9.1', repo: 'me/fork' });
  });

  it('★ 未知参数必须报错（打错一个字母就静默跑默认行为 = 发版脚本最危险的故障）', () => {
    const parsed = parseArgs(['--comfirm']);
    expect(parsed.ok).toBe(false);
  });

  it('--tag / --repo 缺值或格式不对 → 报错', () => {
    expect(parseArgs(['--tag']).ok).toBe(false);
    expect(parseArgs(['--tag', '--confirm']).ok).toBe(false);
    expect(parseArgs(['--repo', 'not-a-repo']).ok).toBe(false);
  });
});

describe('release-publish · findToken / tagExists / listAssets', () => {
  it('★ token 只从环境变量读，空串与空白都算没有', () => {
    expect(findToken({ GITHUB_TOKEN: 'ghp_x' })).toBe('ghp_x');
    expect(findToken({ GITHUB_TOKEN: '  ' })).toBeNull();
    expect(findToken({})).toBeNull();
    // 其它常见变量名刻意不认（避免「以为设置了其实没设」）
    expect(findToken({ GH_TOKEN: 'ghp_x' })).toBeNull();
  });

  it('tagExists：git 有输出就是存在；git 报错按「不存在」处理（不阻塞演练）', () => {
    expect(tagExists('v1', () => 'v1\n')).toBe(true);
    expect(tagExists('v1', () => '')).toBe(false);
    expect(
      tagExists('v1', () => {
        throw new Error('not a git repo');
      }),
    ).toBe(false);
  });

  it('listAssets：目录不存在返回空数组；文件按名字排序（请求顺序可复现）', () => {
    expect(listAssets(join(tmpdir(), 'definitely-missing-dir-xyz'))).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'jd-rel-'));
    try {
      writeFileSync(join(dir, 'b.txt'), 'b');
      writeFileSync(join(dir, 'a.txt'), 'a');
      expect(listAssets(dir).map((asset) => asset.name)).toEqual(['a.txt', 'b.txt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('release-publish · buildPlan（全部拒绝逻辑都在这里）', () => {
  const base = { token: 'ghp_x', confirm: false, tag: 'v0.9.1', repo: 'me/fork', tagExists: false, expectedDir: '/x' };

  it('★ 资产不齐 → 退出码 1 且提示先跑 release:prep（不发半个附件）', () => {
    const plan = buildPlan({ ...base, assets: [] });
    expect(plan.ok).toBe(false);
    expect(plan.code).toBe(1);
    expect(plan.messages.join('\n')).toContain('release:prep');
    expect(plan.steps).toEqual([]);
  });

  it('有资产但缺 SHA256SUMS → 拒绝（没有校验和的发布等于让用户裸下载）', () => {
    const plan = buildPlan({ ...base, assets: [goodAssets[1]] });
    expect(plan.ok).toBe(false);
    expect(plan.messages.join('\n')).toContain('SHA256SUMS');
  });

  it('★ tag 已存在 → 拒绝，且提示不会替你删旧 Release（Q8）', () => {
    const plan = buildPlan({ ...base, tagExists: true, assets: goodAssets });
    expect(plan.ok).toBe(false);
    expect(plan.messages.join('\n')).toContain('只发新 Release');
    expect(plan.steps).toEqual([]);
  });

  it('★ 缺 GITHUB_TOKEN → 退出码 1（即使加了 --confirm 也不发）', () => {
    const plan = buildPlan({ ...base, token: null, confirm: true, assets: goodAssets });
    expect(plan.ok).toBe(false);
    expect(plan.code).toBe(1);
    expect(plan.messages.join('\n')).toContain('GITHUB_TOKEN');
  });

  it('默认演练：生成计划但 mode=dry-run，文案说明「没有发出」', () => {
    const plan = buildPlan({ ...base, assets: goodAssets });
    expect(plan.ok).toBe(true);
    expect(plan.mode).toBe('dry-run');
    expect(plan.messages.join('\n')).toContain('没有发出');
    expect(plan.steps).toHaveLength(1 + goodAssets.length);
  });

  it('★ 请求清单里永远没有 PATCH / PUT / DELETE（Q8 的硬约束）', () => {
    const plan = buildPlan({ ...base, confirm: true, assets: goodAssets });
    expect(plan.mode).toBe('publish');
    expect(repoNames(plan.steps).every((method) => method === 'POST')).toBe(true);
    expect(plan.steps[1].path).toContain('/releases/:id/assets?name=SHA256SUMS');
  });
});

describe('release-publish · main（注入 io，不联网）', () => {
  let dir = '';
  let lines = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jd-reldir-'));
    writeFileSync(join(dir, 'index.html'), '<html></html>');
    writeFileSync(join(dir, 'SHA256SUMS'), 'abc index.html');
    lines = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const io = (overrides = {}) => ({
    env: { GITHUB_TOKEN: 'ghp_x' },
    dir,
    version: '0.9.1',
    print: (out) => lines.push(...out),
    printErr: (out) => lines.push(...out),
    runGit: () => '',
    sender: vi.fn(async () => ({ status: 201, body: '{"id":7}' })),
    ...overrides,
  });

  it('★★ 默认演练：退出码 0，但 sender 一次都没被调用（一个请求都没发）', async () => {
    const options = io();
    const code = await main([], options);
    expect(code).toBe(0);
    expect(options.sender).not.toHaveBeenCalled();
    // ★ v0.9.1 起 host 是请求计划的一部分：资产上传必须显示为 uploads.github.com
    //   （api.github.com 的同名路径只接受 GET，演练必须能暴露 host 错误）
    expect(lines.join('\n')).toContain('POST https://api.github.com/repos/Rrrayy/job-desk/releases');
    expect(lines.join('\n')).toContain(
      'POST https://uploads.github.com/repos/Rrrayy/job-desk/releases/:id/assets?name=SHA256SUMS',
    );
  });

  it('★ 未知参数 → 退出码 2（与「缺 token 的 1」区分开）', async () => {
    const code = await main(['--oops'], io());
    expect(code).toBe(2);
  });

  it('缺 token + --confirm → 退出码 1，且仍然没发任何请求', async () => {
    const options = io({ env: {} });
    const code = await main(['--confirm'], options);
    expect(code).toBe(1);
    expect(options.sender).not.toHaveBeenCalled();
  });

  it('tag 已存在 → 退出码 1（runGit 返回非空）', async () => {
    const options = io({ runGit: (args) => (args.includes('v0.9.1') ? 'v0.9.1\n' : '') });
    const code = await main(['--confirm'], options);
    expect(code).toBe(1);
    expect(options.sender).not.toHaveBeenCalled();
  });

  it('--confirm + 有 token → 先建 Release 再逐个上传附件，方法全是 POST', async () => {
    const options = io();
    const code = await main(['--confirm'], options);
    expect(code).toBe(0);
    // 1 次建 Release + 2 个附件
    expect(options.sender).toHaveBeenCalledTimes(3);
    const methods = options.sender.mock.calls.map((call) => call[0].method);
    expect(methods.every((method) => method === 'POST')).toBe(true);
    const paths = options.sender.mock.calls.map((call) => call[0].path);
    expect(paths[1]).toContain('/releases/7/assets?name=SHA256SUMS');
    expect(lines.join('\n')).toContain('发布完成');
  });

  it('创建 Release 失败（HTTP 422）→ 退出码 1，不会继续传附件', async () => {
    const sender = vi.fn(async () => ({ status: 422, body: '{"message":"already_exists"}' }));
    const code = await main(['--confirm'], io({ sender }));
    expect(code).toBe(1);
    expect(sender).toHaveBeenCalledTimes(1);
  });
});
