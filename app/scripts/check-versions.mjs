#!/usr/bin/env node
/**
 * 版本一致性闸门。
 *
 * 起因（v0.4 发版实测）：Release 页写着 v0.4.0，扩展 zip 里的 manifest 还是 0.2.0，
 * 设置页底部还写着「求职工作台 v0.2」—— 三处各说各话，用户根本不知道自己装的是什么。
 * 这个脚本把「版本号的唯一来源」这件事变成 CI 可检查的硬约束。
 *
 * 检查项：
 *   1. extension/manifest.json 的 version === app/package.json 的 version
 *   2. 如果 dist/index.html 存在，必须包含 `v<version>` 字样（防止拿旧产物发新版）
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(APP_DIR, '..');

const pkg = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf-8'));
const ext = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf-8'));

const errors = [];

if (ext.version !== pkg.version) {
  errors.push(
    `扩展版本与主应用不一致：extension/manifest.json = ${ext.version}，app/package.json = ${pkg.version}`,
  );
}

const distPath = join(APP_DIR, 'dist', 'index.html');
if (statSync(distPath, { throwIfNoEntry: false })) {
  const html = readFileSync(distPath, 'utf-8');
  if (!html.includes(`v${pkg.version}`) && !html.includes(JSON.stringify(pkg.version))) {
    errors.push(`dist/index.html 里找不到版本号 ${pkg.version}，产物可能是用旧版本构建的`);
  }
}

if (errors.length > 0) {
  console.error('✗ 版本一致性检查失败：');
  for (const message of errors) console.error(`  - ${message}`);
  process.exit(1);
}

console.log(`✓ 版本一致：v${pkg.version}（主应用 = 浏览器扩展${statSync(distPath, { throwIfNoEntry: false }) ? ' = 产物' : ''}）`);
