/**
 * PluginStorage 表读写（v0.8 / T04，ARCH §1.3 + T01 建表）。
 *
 * 隔离模型：物理键 = `${pluginId}::${key}`（T01 定死的联合主键物理化）。
 * broker 只把逻辑 key 交给本模块，物理键永远由这里拼 —— 插件没有任何途径
 * 把别的 pluginId 塞进物理键（D16 第 3 类越权的服务端防线）。
 *
 * 函数族按「mutate recipe 内的就地编辑」设计（与 ai/suggestions 同款），
 * 返回值只表达「错没错」，不返回新库。
 */

import type { DB, PluginStorage } from '../types';
import type { PluginRegistration } from './types';

/** 单条 value 上限（序列化后字节数） */
export const PLUGIN_VALUE_LIMIT = 256 * 1024;

/** host 保留命名空间：插件注册表存这里，插件不可能声明这个 id */
export const HOST_PLUGIN_ID = '__host__';
export const REGISTRY_STORAGE_KEY = 'registry';
/**
 * 插件包 html 在自己命名空间里的保留键（面板 reload 后要能重建 iframe）。
 *
 * ★ 保留键必须同时满足「合法 logical key」与「插件不可写」两个条件。
 *   v0.8 首版曾用 `__html`，但 isValidPluginKey 要求首字符是字母数字，
 *   `_` 开头直接判非法 —— html 从未落库，沙箱 iframe 永远挂不上（CDP 冒烟抓到的真 bug）。
 *   现在用合法且带 host 前缀的 `host.bundle`，并由 isReservedPluginKey 挡住插件写入。
 */
export const PLUGIN_HTML_KEY = 'host.bundle';
/** host 保留键前缀：插件对这类键的读写一律拒绝（见 broker） */
export const RESERVED_KEY_PREFIX = 'host.';

/** 逻辑 key 合法性：字母数字与 _.- 组成、≤100 字符、不含命名空间分隔符 */
export function isValidPluginKey(key: unknown): key is string {
  return typeof key === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(key) && !key.includes('::');
}

/** host 保留键：插件不可读写（插件包本体、注册表等宿主资产） */
export function isReservedPluginKey(key: string): boolean {
  return key.startsWith(RESERVED_KEY_PREFIX);
}

export function qualifiedKey(pluginId: string, key: string): string {
  return `${pluginId}::${key}`;
}

function findRow(db: DB, pluginId: string, key: string): PluginStorage | undefined {
  const id = qualifiedKey(pluginId, key);
  return db.pluginStorage.find((row) => row.id === id);
}

/** 读。行不存在返回 null（与「存的值就是 null」不可区分 —— 键值存储语义如此） */
export function storageGet(db: DB, pluginId: string, key: string): unknown | null {
  return findRow(db, pluginId, key)?.value ?? null;
}

export type StorageSetError = 'bad_envelope' | 'storage_quota';

/** 写。value 必须 JSON 可序列化且 ≤256 KB；行存在则整行覆盖（联合主键去重语义） */
export function storageSet(db: DB, pluginId: string, key: string, value: unknown, nowIso: string): StorageSetError | null {
  if (!isValidPluginKey(key)) return 'bad_envelope';
  let serialized: string;
  try {
    serialized = JSON.stringify(value ?? null);
  } catch {
    return 'bad_envelope'; // 不可序列化（循环引用等）= 载荷不合规
  }
  if (serialized.length > PLUGIN_VALUE_LIMIT) return 'storage_quota';
  const id = qualifiedKey(pluginId, key);
  const row = db.pluginStorage.find((item) => item.id === id);
  if (row) {
    row.value = JSON.parse(serialized);
    row.updatedAt = nowIso;
    return null;
  }
  db.pluginStorage.push({ id, pluginId, key, value: JSON.parse(serialized), updatedAt: nowIso });
  return null;
}

/** 删。行不存在是正常情况（幂等） */
export function storageDelete(db: DB, pluginId: string, key: string): void {
  if (!isValidPluginKey(key)) return;
  const id = qualifiedKey(pluginId, key);
  db.pluginStorage = db.pluginStorage.filter((row) => row.id !== id);
}

/** 只返回本命名空间的**逻辑**键列表（物理前缀不出 host） */
export function storageKeys(db: DB, pluginId: string): string[] {
  const prefix = `${pluginId}::`;
  return db.pluginStorage
    .filter((row) => row.id.startsWith(prefix))
    .map((row) => row.key);
}

/** 卸载：清掉插件命名空间下的全部行（含 html），host 保留命名空间不受影响 */
export function storagePurgePlugin(db: DB, pluginId: string): void {
  const prefix = `${pluginId}::`;
  db.pluginStorage = db.pluginStorage.filter((row) => !row.id.startsWith(prefix));
}

/* ------------------------------ 注册表（存 host 命名空间） ------------------------------ */

export function readRegistry(db: DB): PluginRegistration[] {
  const row = findRow(db, HOST_PLUGIN_ID, REGISTRY_STORAGE_KEY);
  if (!row || !Array.isArray(row.value)) return [];
  // 行内容在写入侧已校验；读取侧只挡明显脏数据，不做全量重建
  return row.value.filter(
    (item): item is PluginRegistration =>
      typeof item === 'object' && item !== null && typeof (item as PluginRegistration).pluginId === 'string',
  );
}

export function writeRegistry(db: DB, list: PluginRegistration[], nowIso: string): void {
  storageSet(db, HOST_PLUGIN_ID, REGISTRY_STORAGE_KEY, list, nowIso);
}

/** 插件 id：从包名生成稳定 slug（中英文名都支持；同名同包 = 同 id，天然去重/升级） */
export function pluginIdForName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `plugin:${slug || 'unnamed'}`;
}
