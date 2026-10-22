/**
 * 照片处理的两条纯逻辑（`byteSizeOf` / `fitWithin`）+ 拒绝路径。
 *
 * 为什么不测「真的压缩出一张图」：node 里没有 canvas、jsdom 里没有编解码器，
 * 硬测只会得到一条「stub 了自己实现」的假测试。压缩本身是 15 行 canvas 调用，
 * 真正会咬人的是**边界条件**：字节数怎么算、缩放后会不会糊、超限怎么拒 ——
 * 这三件事都在纯函数里，也都在这里测。
 */

import { describe, expect, it } from 'vitest';
import {
  PHOTO_MAX_BYTES,
  PHOTO_MAX_WIDTH,
  PHOTO_NOT_IMAGE,
  PHOTO_UNSUPPORTED,
  byteSizeOf,
  compressPhoto,
  fitWithin,
} from './photo';

/** 造一个 base64 载荷（真实字符集，长度才是真的） */
function base64Of(bytes: number): string {
  return Buffer.alloc(bytes, 0x41).toString('base64');
}

describe('照片上限与体积计算', () => {
  it('上限是宽 480px、80 KB（PRD §8.3 的硬数字，改动必须同步改文档）', () => {
    expect(PHOTO_MAX_WIDTH).toBe(480);
    expect(PHOTO_MAX_BYTES).toBe(80 * 1024);
  });

  it('★ 字节数按**解码后**算（用户理解的 80 KB 是图片体积，不是 base64 长度）', () => {
    expect(byteSizeOf('')).toBe(0);
    // 3 字节 → 4 字符，无填充
    expect(byteSizeOf(`data:image/jpeg;base64,${base64Of(3)}`)).toBe(3);
    // 1 字节 → 4 字符 + '=='（含填充时少算 2 个字节）
    expect(byteSizeOf(`data:image/jpeg;base64,${base64Of(1)}`)).toBe(1);
    expect(byteSizeOf(`data:image/jpeg;base64,${base64Of(2)}`)).toBe(2);
    expect(byteSizeOf(`data:image/jpeg;base64,${base64Of(80 * 1024)}`)).toBe(80 * 1024);
  });

  it('没有 data: 前缀也照样算（容错，不抛）', () => {
    expect(byteSizeOf(base64Of(9))).toBe(9);
  });
});

describe('等比缩放', () => {
  it('宽超限 → 按宽度缩，比例不变', () => {
    expect(fitWithin(960, 1280, 480)).toEqual({ width: 480, height: 640 });
    expect(fitWithin(1000, 1000, 480)).toEqual({ width: 480, height: 480 });
  });

  it('已经够小 → 原样保留（绝不放大：放大只是把像素拉糊，体积还更大）', () => {
    expect(fitWithin(200, 300, 480)).toEqual({ width: 200, height: 300 });
    expect(fitWithin(480, 600, 480)).toEqual({ width: 480, height: 600 });
  });

  it('极端比例：极宽的图缩完高度不小于 1px（0 高度会让 canvas 直接失效）', () => {
    const box = fitWithin(4800, 3, 480);
    expect(box.width).toBe(480);
    expect(box.height).toBeGreaterThanOrEqual(1);
  });

  it('非法尺寸 → 退回正方形上限（而不是产出 0×0 的坏 canvas）', () => {
    expect(fitWithin(0, 0, 480)).toEqual({ width: 480, height: 480 });
    expect(fitWithin(Number.NaN, 100, 480)).toEqual({ width: 480, height: 480 });
  });
});

describe('压缩的拒绝路径（失败必须说人话，不抛错）', () => {
  it('非图片文件 → 明确说「不是图片」', async () => {
    const file = new File(['hello'], 'a.txt', { type: 'text/plain' });
    await expect(compressPhoto(file)).resolves.toEqual({ ok: false, reason: PHOTO_NOT_IMAGE });
  });

  it('没有 canvas 的环境（node）→ 明确说「不支持」，而不是抛 ReferenceError', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' });
    await expect(compressPhoto(file)).resolves.toEqual({ ok: false, reason: PHOTO_UNSUPPORTED });
  });
});
