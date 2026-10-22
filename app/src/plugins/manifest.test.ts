/**
 * manifest 解析单测（v0.8 / T04）。
 * 载体：`<script type="application/json" id="plugin-manifest">`。
 */

import { describe, expect, it } from 'vitest';
import { isValidPermission, parseManifest } from './manifest';

function wrap(json: string): string {
  return `<!doctype html><html><head><script type="application/json" id="plugin-manifest">${json}</` + `script></head><body></body></html>`;
}

const VALID = wrap('{"name":"Demo 插件","version":"1.2.3","permissions":["storage","network:demo","suggest:application_note"]}');

describe('manifest · 解析', () => {
  it('合法清单：name/version/permissions 原样出', () => {
    const result = parseManifest(VALID);
    expect(result).toEqual({
      ok: true,
      manifest: {
        name: 'Demo 插件',
        version: '1.2.3',
        permissions: ['storage', 'network:demo', 'suggest:application_note'],
      },
    });
  });

  it('没有清单 script / JSON 损坏 / 顶层数组 → 各给一句可读原因', () => {
    expect(parseManifest('<html><body>x</body></html>').ok).toBe(false);
    expect(parseManifest(wrap('{broken')).ok).toBe(false);
    expect(parseManifest(wrap('[]')).ok).toBe(false);
  });

  it('字段校验：name/version/permissions 逐项拦', () => {
    expect(parseManifest(wrap('{"name":"","version":"1.0.0","permissions":["storage"]}')).ok).toBe(false);
    expect(parseManifest(wrap(`{"name":"${'长'.repeat(41)}","version":"1.0.0","permissions":["storage"]}`)).ok).toBe(false);
    expect(parseManifest(wrap('{"name":"a","version":"1.0","permissions":["storage"]}')).ok).toBe(false);
    expect(parseManifest(wrap('{"name":"a","version":"1.0.0","permissions":[]}')).ok).toBe(false);
    expect(parseManifest(wrap('{"name":"a","version":"1.0.0","permissions":["storage","storage"]}')).ok).toBe(false);
    expect(parseManifest(wrap('{"name":"a","version":"1.0.0","permissions":["storage","fetch:all"]}')).ok).toBe(false);
    expect(parseManifest(wrap('{"name":"a","version":"1.0.0","permissions":["suggest:jd_match"]}')).ok).toBe(false);
  });
});

describe('manifest · 权限字面量', () => {
  it('storage / network:<场景> / suggest:<3 目标> 合法；其余全拒', () => {
    expect(isValidPermission('storage')).toBe(true);
    expect(isValidPermission('network:notes-cleanup')).toBe(true);
    expect(isValidPermission('suggest:question')).toBe(true);
    expect(isValidPermission('suggest:staging_field')).toBe(true);
    expect(isValidPermission('network:')).toBe(false);
    expect(isValidPermission('suggest:jd_match')).toBe(false);
    expect(isValidPermission('fetch:all')).toBe(false);
    expect(isValidPermission(42)).toBe(false);
  });
});
