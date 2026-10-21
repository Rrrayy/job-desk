import { describe, expect, it } from 'vitest';
import {
  PORTABLE_FILES,
  buildZip,
  crc32,
  formatSums,
  portableReadme,
  portableZipName,
} from './portable';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 从 ZIP 尾部读 EOCD，做最基本的合规检查（真实解压器读的就是这些字段） */
function readEocd(zip: Uint8Array) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // EOCD 在最后 22 字节（本项目不写注释）
  const base = zip.length - 22;
  expect(view.getUint32(base, true)).toBe(0x06054b50);
  return {
    count: view.getUint16(base + 10, true),
    centralSize: view.getUint32(base + 12, true),
    centralOffset: view.getUint32(base + 16, true),
  };
}

describe('crc32', () => {
  it('与标准测试向量一致', () => {
    // "123456789" 的 CRC32 是 0xCBF43926，这是 CRC 的标准校验向量
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
  });

  it('空数据为 0', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('buildZip', () => {
  it('条目数、中央目录位置正确', () => {
    const zip = buildZip([
      { name: 'a.txt', data: enc.encode('hello') },
      { name: 'b.txt', data: enc.encode('世界') },
    ]);
    const eocd = readEocd(zip);
    expect(eocd.count).toBe(2);
    expect(eocd.centralOffset).toBeGreaterThan(0);
    expect(eocd.centralOffset + eocd.centralSize).toBe(zip.length - 22);
  });

  it('能按中央目录把内容原样读回来', () => {
    const files = [
      { name: 'index.html', data: enc.encode('<html>工作台</html>') },
      { name: 'data.json', data: enc.encode('{"applications":[]}') },
    ];
    const zip = buildZip(files);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const eocd = readEocd(zip);

    let cursor = eocd.centralOffset;
    for (const file of files) {
      expect(view.getUint32(cursor, true)).toBe(0x02014b50);
      const method = view.getUint16(cursor + 10, true);
      expect(method).toBe(0); // store，未压缩
      const crc = view.getUint32(cursor + 16, true);
      const size = view.getUint32(cursor + 24, true);
      const nameLen = view.getUint16(cursor + 28, true);
      const localOffset = view.getUint32(cursor + 42, true);
      const name = dec.decode(zip.subarray(cursor + 46, cursor + 46 + nameLen));
      expect(name).toBe(file.name);

      // 跳到局部头，取出数据
      const localNameLen = view.getUint16(localOffset + 26, true);
      const localExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const data = zip.subarray(dataStart, dataStart + size);
      expect(dec.decode(data)).toBe(dec.decode(file.data));
      expect(crc32(data)).toBe(crc);

      cursor += 46 + nameLen;
    }
  });

  it('同一份输入打两次字节完全相同（可复现）', () => {
    const make = () =>
      buildZip([
        { name: PORTABLE_FILES.app, data: enc.encode('<html></html>') },
        { name: PORTABLE_FILES.data, data: enc.encode('{}') },
      ]);
    expect(Array.from(make())).toEqual(Array.from(make()));
  });

  it('空条目列表也是合法 ZIP（只有 EOCD）', () => {
    const zip = buildZip([]);
    expect(zip.length).toBe(22);
    expect(readEocd(zip).count).toBe(0);
  });

  it('中文文件名走 UTF-8 标志位', () => {
    const zip = buildZip([{ name: PORTABLE_FILES.readme, data: enc.encode('说明') }]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    // 局部头通用标志位在偏移 6
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
  });
});

describe('portableZipName', () => {
  it('带本地日期与时分', () => {
    const name = portableZipName(new Date(2026, 9, 21, 9, 5));
    expect(name).toBe('求职工作台-便携包-2026-10-21-0905.zip');
  });

  it('同一天不同时刻不重名', () => {
    const a = portableZipName(new Date(2026, 9, 21, 9, 5));
    const b = portableZipName(new Date(2026, 9, 21, 9, 6));
    expect(a).not.toBe(b);
  });
});

describe('formatSums', () => {
  it('两个空格分隔，sha256sum -c 能认', () => {
    const text = formatSums([{ name: 'index.html', sha256: 'abc' }]);
    expect(text).toBe('abc  index.html\n');
  });
});

describe('portableReadme', () => {
  it('写清了版本、数据量、怎么用', () => {
    const text = portableReadme('0.5.0', '2026-10-21 09:05', {
      applications: 12,
      companies: 5,
      interviews: 3,
    });
    expect(text).toContain('0.5.0');
    expect(text).toContain('12 条投递');
    expect(text).toContain('双击 index.html');
    expect(text).toContain('data.json');
  });
});
