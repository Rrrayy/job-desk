/**
 * 打发布资产：把单文件产物 + 浏览器扩展打成可直接上传到 GitHub Release 的文件。
 *
 * 为什么自己写 ZIP 而不是装 `archiver` / 调系统 `zip`：
 *   1. 本项目对外承诺「运行期零依赖」，构建链也尽量不给贡献者加安装负担；
 *      真实情况是 Windows 上默认没有 zip、`7z` 也不一定有。
 *   2. 发布资产必须**可复现**：同样的输入产出同样的 sha256。
 *      系统 zip 会把当前时间写进条目头，每次打出来的哈希都不一样，
 *      那「校验和」就退化成「参考值」。这里用固定 DOS 时间戳 + 固定顺序。
 *   ZIP 的 store / deflate 两种方法都是压缩包格式本身，Node 的 zlib 已内置，不需要第三方库。
 *
 * 用法：node scripts/pack-release.mjs
 * 产物：release/<version>/index.html、job-desk-extension-<version>.zip、SHA256SUMS、manifest.json
 */
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = resolve(APP_DIR, '..');
const DIST = join(APP_DIR, 'dist', 'index.html');
const EXT_DIR = join(REPO_DIR, 'extension');

/** 固定时间戳（2026-10-20 22:00），让压缩包哈希稳定。DOS 时间从 1980 年起算。 */
const DOS_DATE = ((2026 - 1980) << 9) | (10 << 5) | 20;
const DOS_TIME = (22 << 11) | (0 << 5) | 0;

const pkg = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const OUT_DIR = join(REPO_DIR, 'release', `v${VERSION}`);

/* ------------------------------------------------------------------ CRC32 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* -------------------------------------------------------------------- ZIP */

/**
 * @param {{name: string, data: Buffer}[]} entries 顺序即写入顺序，调用方负责排序
 * @returns {Buffer}
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const compressed = deflateRawSync(entry.data, { level: 9 });

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 局部文件头签名
    local.writeUInt16LE(20, 4); // 解压所需版本 2.0
    local.writeUInt16LE(0x0800, 6); // 通用标志：文件名 UTF-8
    local.writeUInt16LE(8, 8); // 压缩方法：deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra 长度
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    central.writeUInt16LE(20, 4); // 创建版本
    central.writeUInt16LE(20, 6); // 解压所需版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // 起始磁盘号
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(0, 38); // 外部属性
    central.writeUInt32LE(offset, 42); // 局部头偏移
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // 中央目录结束记录
  eocd.writeUInt16LE(0, 4); // 当前磁盘号
  eocd.writeUInt16LE(0, 6); // 中央目录起始磁盘号
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // 注释长度

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/* ------------------------------------------------------------------ 工具 */

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 递归收集扩展目录下的文件，按相对路径排序 —— 排序是为了让压缩包可复现。 */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/* ------------------------------------------------------------------ 主流程 */

if (!statSync(DIST, { throwIfNoEntry: false })) {
  console.error('✗ 找不到 app/dist/index.html，先运行 npm run build');
  process.exit(1);
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

// 1. 单文件应用：原样复制，改名 index.html 便于下载后双击
const html = readFileSync(DIST);
const htmlOut = join(OUT_DIR, 'index.html');
writeFileSync(htmlOut, html);

// 2. 扩展：只打运行期需要的文件，把 README 留在仓库里（下载者不需要）
const extFiles = walk(EXT_DIR).filter((f) => !f.endsWith('README.md'));
const zipBuf = makeZip(
  extFiles.map((f) => ({
    name: `job-desk-extension/${relative(EXT_DIR, f).split('\\').join('/')}`,
    data: readFileSync(f),
  })),
);
const zipName = `job-desk-extension-v${VERSION}.zip`;
const zipOut = join(OUT_DIR, zipName);
writeFileSync(zipOut, zipBuf);

// 3. 校验和：发布页上让下载者能自己核对
const sums = [
  `${sha256(html)}  index.html`,
  `${sha256(zipBuf)}  ${zipName}`,
].join('\n');
writeFileSync(join(OUT_DIR, 'SHA256SUMS'), `${sums}\n`);

// 4. manifest：脚本自己产出事实，release notes 里的数字就不用手抄
const manifest = {
  name: 'job-desk',
  version: VERSION,
  releasedAt: '2026-10-20T22:00:00+08:00',
  assets: [
    { file: 'index.html', bytes: html.length, sha256: sha256(html), kind: 'single-file-app' },
    { file: zipName, bytes: zipBuf.length, sha256: sha256(zipBuf), kind: 'browser-extension' },
  ],
  extensionEntries: extFiles.map((f) => relative(EXT_DIR, f).split('\\').join('/')),
};
writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

/* ------------------------------------------------------------------ 输出 */

console.log(`发布资产已生成：release/v${VERSION}/`);
console.log(`  index.html                      ${String(html.length).padStart(9)} B  (${kb(html.length)})`);
console.log(`  ${zipName.padEnd(31)} ${String(zipBuf.length).padStart(9)} B  (${kb(zipBuf.length)})`);
console.log(`  SHA256SUMS · manifest.json`);
console.log('');
console.log(`  index.html  sha256 ${sha256(html)}`);
console.log(`  ${zipName}  sha256 ${sha256(zipBuf)}`);
console.log('');

// 体积承诺也在这里兜一道：发布资产和 check:bundle 用的是同一个文件，不该出现两个数
if (html.length !== statSync(DIST).size) {
  console.error('✗ 复制后的字节数与 dist 不一致，发布资产不可信');
  process.exit(1);
}
console.log('✓ 打包完成（固定时间戳 + 固定顺序，同一份 dist 重复打包哈希一致）');
