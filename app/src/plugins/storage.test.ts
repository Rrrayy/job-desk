/**
 * PluginStorage 单测（v0.8 / T04）：命名空间隔离、联合主键、配额、注册表。
 * D16 第 3 类（跨 pluginId 读写）的服务端防线在这里断言。
 */

import { describe, expect, it } from 'vitest';
import {
  HOST_PLUGIN_ID,
  PLUGIN_HTML_KEY,
  PLUGIN_VALUE_LIMIT,
  isReservedPluginKey,
  isValidPluginKey,
  pluginIdForName,
  readRegistry,
  storageDelete,
  storageGet,
  storageKeys,
  storagePurgePlugin,
  storageSet,
  writeRegistry,
} from './storage';
import { emptyDB } from '../lib/defaults';
import type { PluginRegistration } from './types';

const NOW = '2026-10-21T10:00:00.000Z';

describe('pluginStorage · 读写', () => {
  it('set/get 往返，物理 id = pluginId::key，同 key 覆盖不重复', () => {
    const db = emptyDB();
    expect(storageSet(db, 'plugin:a', 'k1', { x: 1 }, NOW)).toBeNull();
    expect(storageSet(db, 'plugin:a', 'k1', { x: 2 }, NOW)).toBeNull();
    expect(db.pluginStorage).toHaveLength(1);
    expect(db.pluginStorage[0]).toMatchObject({ id: 'plugin:a::k1', pluginId: 'plugin:a', key: 'k1' });
    expect(storageGet(db, 'plugin:a', 'k1')).toEqual({ x: 2 });
    expect(storageGet(db, 'plugin:a', 'missing')).toBeNull();
  });

  it('跨 pluginId 命名空间隔离（D16 第 3 类）', () => {
    const db = emptyDB();
    storageSet(db, 'plugin:a', 'shared-key', 'A 的数据', NOW);
    // pluginB 用同样的逻辑 key 读 —— 物理键不同，读到的是 null
    expect(storageGet(db, 'plugin:b', 'shared-key')).toBeNull();
    expect(storageKeys(db, 'plugin:a')).toEqual(['shared-key']);
    expect(storageKeys(db, 'plugin:b')).toEqual([]);
    // 即便 pluginB 试图把「plugin:a::secret」当逻辑 key，也会被键合法性拒绝
    expect(storageSet(db, 'plugin:b', 'plugin:a::secret', 'x', NOW)).toBe('bad_envelope');
    expect(storageGet(db, 'plugin:b', 'plugin:a::secret')).toBeNull();
  });

  it('key 合法性：空 / :: / 非法字符 / 超长 全拒', () => {
    expect(isValidPluginKey('ok-key_1.2')).toBe(true);
    expect(isValidPluginKey('')).toBe(false);
    expect(isValidPluginKey('a::b')).toBe(false);
    expect(isValidPluginKey('空格 key')).toBe(false);
    expect(isValidPluginKey(`x`.repeat(101))).toBe(false);
    expect(isValidPluginKey(42)).toBe(false);
  });

  it('单条 ≤256 KB（序列化后），超限 storage_quota', () => {
    const db = emptyDB();
    const big = 'x'.repeat(PLUGIN_VALUE_LIMIT);
    expect(storageSet(db, 'plugin:a', 'big', big, NOW)).toBe('storage_quota');
    expect(storageSet(db, 'plugin:a', 'ok', 'x'.repeat(PLUGIN_VALUE_LIMIT - 16), NOW)).toBeNull();
  });

  it('delete 幂等；purge 清插件命名空间但不动 host 保留区', () => {
    const db = emptyDB();
    storageSet(db, 'plugin:a', 'k1', 1, NOW);
    storageSet(db, 'plugin:a', 'k2', 2, NOW);
    writeRegistry(db, [], NOW);
    storageDelete(db, 'plugin:a', 'k1');
    storageDelete(db, 'plugin:a', 'missing');
    expect(storageKeys(db, 'plugin:a')).toEqual(['k2']);

    storageSet(db, HOST_PLUGIN_ID, 'registry', [], NOW);
    storagePurgePlugin(db, 'plugin:a');
    expect(db.pluginStorage.some((row) => row.pluginId === HOST_PLUGIN_ID)).toBe(true);
  });
});

describe('pluginStorage · 注册表', () => {
  const registration: PluginRegistration = {
    pluginId: 'plugin:demo',
    name: 'Demo',
    version: '1.0.0',
    permissions: ['storage'],
    enabled: false,
    granted: [],
  };

  it('write/read 往返；未写时为空数组', () => {
    const db = emptyDB();
    expect(readRegistry(db)).toEqual([]);
    writeRegistry(db, [registration], NOW);
    expect(readRegistry(db)).toEqual([registration]);
    // 脏数据行被挡掉
    const row = db.pluginStorage.find((item) => item.pluginId === HOST_PLUGIN_ID);
    expect(row).toBeDefined();
    row!.value = [registration, { garbage: true }, null];
    expect(readRegistry(db)).toEqual([registration]);
  });

  it('pluginIdForName：中英文 slug 稳定，同名同 id（天然升级）', () => {
    expect(pluginIdForName('Demo 插件')).toBe(pluginIdForName('Demo 插件'));
    expect(pluginIdForName('笔记 AI 助手')).toMatch(/^plugin:笔记-ai-助手$/);
    expect(pluginIdForName('Notes AI')).toBe('plugin:notes-ai');
    expect(pluginIdForName('!!!')).toBe('plugin:unnamed');
  });
});

describe('PLUGIN_HTML_KEY 不变式（v0.8 CDP 冒烟回归）', () => {
  /*
   * 首版用 `__html` 做插件包保留键，但 isValidPluginKey 要求首字符字母数字，
   * html 从未落库 → 沙箱 iframe 永远空挂。这条用例就是防它再犯：
   * 保留键必须同时「合法」且「被 host 独占」。
   */
  it('保留键是合法 logical key（能真正写进 storage）', () => {
    expect(isValidPluginKey(PLUGIN_HTML_KEY)).toBe(true);
    const db = emptyDB();
    expect(storageSet(db, 'plugin:a', PLUGIN_HTML_KEY, '<html></html>', NOW)).toBeNull();
    expect(storageGet(db, 'plugin:a', PLUGIN_HTML_KEY)).toBe('<html></html>');
  });

  it('保留键被判定为 host 独占（broker 据此拒绝插件读写）', () => {
    expect(isReservedPluginKey(PLUGIN_HTML_KEY)).toBe(true);
    expect(isReservedPluginKey('notes')).toBe(false);
  });

  it('readRegistry 写的是 host 命名空间，不在任何插件命名空间里', () => {
    const db = emptyDB();
    const reg: PluginRegistration[] = [{ pluginId: 'plugin:a', name: 'A', version: '1.0.0', permissions: [], enabled: false, granted: [] }];
    writeRegistry(db, reg, NOW);
    expect(readRegistry(db)).toEqual(reg);
    expect(storageKeys(db, 'plugin:a')).toEqual([]);
    expect(db.pluginStorage.every((row) => row.pluginId === HOST_PLUGIN_ID)).toBe(true);
  });
});
