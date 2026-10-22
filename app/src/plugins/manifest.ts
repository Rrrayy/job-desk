/**
 * 插件包 manifest 解析（v0.8 / T04，ARCH §1.3）。
 *
 * 载体形态：插件包 = 单个 html，manifest 内联在
 * `<script type="application/json" id="plugin-manifest">{...}</script>` 里。
 * 选 JSON script 而不是 HTML 注释的理由：注释要用正则抠文本、没法防「注释里
 * 再套注释」这种畸形；JSON script 是浏览器原生的结构化数据通道，JSON.parse
 * 失败即拒绝，校验面最小、字节最省。
 */

import type { AISuggestionTargetType } from '../types';
import type { PluginManifest, PluginPermission } from './types';

const MANIFEST_SCRIPT_RE =
  /<script[^>]*type=["']application\/json["'][^>]*id=["']plugin-manifest["'][^>]*>([\s\S]*?)<\/script>/i;

const TARGET_TYPES: readonly AISuggestionTargetType[] = ['question', 'application_note', 'staging_field'];

export type ManifestResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; error: string };

/** 单条权限校验（与类型层 PluginPermission 字面量对齐；枚举只增不改） */
export function isValidPermission(value: unknown): value is PluginPermission {
  if (value === 'storage') return true;
  if (typeof value !== 'string') return false;
  if (value.startsWith('network:')) return value.length > 'network:'.length && /^[a-z0-9-]{1,40}$/i.test(value.slice(8));
  if (value.startsWith('suggest:')) return (TARGET_TYPES as readonly string[]).includes(value.slice(8));
  return false;
}

/** 从插件包 html 文本解析并校验 manifest。任何不合规都给一句可读原因 */
export function parseManifest(html: string): ManifestResult {
  const match = MANIFEST_SCRIPT_RE.exec(html);
  if (!match) {
    return { ok: false, error: '插件包里没有 <script type="application/json" id="plugin-manifest"> 清单' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return { ok: false, error: 'manifest 不是合法 JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'manifest 顶层必须是对象' };
  }
  const raw = parsed as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > 40) return { ok: false, error: 'manifest.name 必须是 1~40 字符' };
  const version = typeof raw.version === 'string' ? raw.version.trim() : '';
  if (!/^\d+\.\d+\.\d+$/.test(version)) return { ok: false, error: 'manifest.version 必须是 x.y.z 形式' };
  if (!Array.isArray(raw.permissions) || raw.permissions.length === 0) {
    return { ok: false, error: 'manifest.permissions 必须是非空数组（插件至少要声明一个权限）' };
  }
  if (raw.permissions.length > 16) return { ok: false, error: 'manifest.permissions 超过 16 条，疑似滥权' };
  const seen = new Set<string>();
  const permissions: PluginPermission[] = [];
  for (const value of raw.permissions) {
    if (!isValidPermission(value)) {
      return { ok: false, error: `未知权限：${String(value)}（合法：storage / network:<场景> / suggest:<目标>）` };
    }
    if (seen.has(value)) return { ok: false, error: `权限重复声明：${value}` };
    seen.add(value);
    permissions.push(value);
  }
  return { ok: true, manifest: { name, version, permissions } };
}
