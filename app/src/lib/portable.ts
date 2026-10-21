/**
 * 便携导出（v0.5 / D5）：把「应用本体 + 当前数据」打成一个 zip。
 *
 * 为什么需要：JSON 备份只有数据，用户拿到之后还得先找到那个 index.html
 * 才能导回去 —— 「我把工作台和数据发给朋友」这件事在 v0.4.1 是做不完整的。
 *
 * 设计取舍：
 * 1. **不压缩**（ZIP store 模式）。应用 HTML 本身已经压过一次（vite 产物），
 *    再 deflate 通常只省 5%，却要引入压缩实现或依赖浏览器 CompressionStream
 *    （Safari 支持得晚）。store 模式下 ~90 行就能写出合规的 zip。
 * 2. **可复现**：固定 DOS 时间戳 + 固定条目顺序，同一份数据打两次哈希一致。
 *    这样「校验和」才有意义，而不是每次都不一样的一串数。
 * 3. 文件名带本地日期和时分，同一天导出多次不会互相覆盖。
 */

/** ZIP 条目：name 用正斜杠分隔（ZIP 规范要求） */
export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/**
 * 固定时间戳：2026-10-20 22:00（本地时间语义，DOS 时间从 1980 年起算）。
 * 故意不用 `new Date()` —— 见文件头的「可复现」。
 */
const DOS_DATE = ((2026 - 1980) << 9) | (10 << 5) | 20;
const DOS_TIME = (22 << 11) | (0 << 5) | 0;

/**
 * CRC32 查表。运行时现算而不是写字面量表 ——
 * 256 个整数的字面量在产物里约占 1.5 KB，而这段循环只在模块首次加载跑 256×8 次，
 * 微秒级。单文件产物的每一 KB 都是用户要下载的，这类「一次性换算」不值得固化。
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();

function bytesOf(input: Uint8Array | string): Uint8Array {
  return typeof input === 'string' ? encoder.encode(input) : input;
}

/**
 * 生成 ZIP（store 模式）。
 * 返回 Uint8Array，调用方自己包 Blob —— 这样不打 `Blob` 的类型假设，
 * 也方便单测直接比对字节。
 */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = bytesOf(entry.data);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // 局部文件头
    lv.setUint16(4, 20, true); // 解压所需版本 2.0
    lv.setUint16(6, 0x0800, true); // 文件名 UTF-8
    lv.setUint16(8, 0, true); // 压缩方法 0 = store
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // 压缩后大小 = 原大小
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra 长度
    local.set(nameBytes, 30);

    parts.push(local, data);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); // 中央目录
    cv.setUint16(4, 20, true); // 创建版本
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // 起始磁盘号
    cv.setUint16(36, 0, true); // 内部属性
    cv.setUint32(38, 0, true); // 外部属性
    cv.setUint32(42, offset, true); // 局部头偏移
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }

  const centralSize = centrals.reduce((sum, buf) => sum + buf.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // 中央目录结束记录
  ev.setUint16(4, 0, true); // 当前磁盘号
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true); // 注释长度

  const all = [...parts, ...centrals, eocd];
  const total = all.reduce((sum, buf) => sum + buf.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const buf of all) {
    out.set(buf, cursor);
    cursor += buf.length;
  }
  return out;
}

/**
 * 便携包里的说明文件 —— 用户解压后第一眼要看的东西。
 *
 * 排版是「标题 + 下划线 + 正文段」的纯文本，刻意不用 markdown：
 * .txt 用记事本打开时 ## 只会让人更困惑。
 */
const README_HEAD = [
  '求职工作台 · 便携包',
  '==================',
  '',
] as const;

const README_BODY = [
  '',
  '怎么用',
  '------',
  '1. 解压到任意文件夹（不要放在压缩包里直接双击）。',
  '2. 双击 index.html，浏览器会打开你的工作台，数据已经在了。',
  '3. 数据存在「那个文件夹对应的浏览器」里：',
  '   · 双击打开（file://）→ 存在浏览器的 localStorage',
  '   · 换电脑 / 换浏览器 → 在新环境里双击 index.html，',
  '     再用「设置 → 导入备份」把 data.json 导进去。',
  '',
  '注意',
  '----',
  '· 这是一个静态网页，不联网、不上传任何东西。',
  '· 清理浏览器数据 / 换浏览器 / 换文件夹，都会看不到这份数据。',
  '· data.json 是唯一可导回的备份格式，请和 index.html 一起保存。',
  '· 设置里开了「备份加密」的话，data.json 需要口令才能导入。',
  '',
  '文件校验：SHA256SUMS 里的哈希可用 certutil -hashfile <文件名> SHA256 核对。',
  '',
].join('\n');

export function portableReadme(
  version: string,
  exportedAt: string,
  counts: { applications: number; companies: number; interviews: number },
): string {
  return (
    README_HEAD.join('\n') +
    `应用版本：${version}\n导出时间：${exportedAt}\n` +
    `内含数据：${counts.applications} 条投递 / ${counts.companies} 家公司 / ${counts.interviews} 场面试\n` +
    README_BODY
  );
}

/** 便携包文件名：带本地日期与时分，同一天导多次不会互相覆盖 */
export function portableZipName(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `求职工作台-便携包-${day}-${time}.zip`;
}

/** 便携包内的文件名（固定，不随导出时间变 —— 解压后再导就靠这个路径） */
export const PORTABLE_FILES = {
  app: 'index.html',
  data: 'data.json',
  readme: '使用说明.txt',
  sums: 'SHA256SUMS',
} as const;

/**
 * 生成 SHA256SUMS 的文本格式（与 `sha256sum -c` 兼容：两个空格分隔）。
 * 浏览器侧用 SubtleCrypto 算哈希，这里只负责排版。
 */
export function formatSums(rows: { name: string; sha256: string }[]): string {
  return `${rows.map((row) => `${row.sha256}  ${row.name}`).join('\n')}\n`;
}
