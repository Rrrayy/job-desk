/** 零散工具函数：id、深拷贝、复制到剪贴板、className 拼接。 */

import type { Company, DB } from '../types';

/** 生成带前缀的短 id */
export function uid(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 结构化深拷贝（DB 只含可 JSON 化数据，用 JSON 就够了） */
export function cloneDB<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** className 拼接，过滤假值 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** 公司显示名：优先简称 */
export function companyLabel(companies: Company[], companyId: string): string {
  const found = companies.find((c) => c.id === companyId);
  if (!found) return '未知公司';
  return found.shortName || found.name;
}

/** 公司全名 */
export function companyFullName(companies: Company[], companyId: string): string {
  const found = companies.find((c) => c.id === companyId);
  return found ? found.name : '未知公司';
}

/** 构建 companyId → Company 的索引 */
export function companyMapOf(db: DB): Map<string, Company> {
  const map = new Map<string, Company>();
  for (const c of db.companies) map.set(c.id, c);
  return map;
}

/**
 * 复制文本到剪贴板。
 * file:// 协议或旧浏览器里 Clipboard API 可能不可用，失败时返回 false，由调用方降级展示。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续尝试降级方案
  }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', 'readonly');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

/**
 * 触发浏览器下载一个 Blob，返回是否成功。
 *
 * `downloadText` 与便携包（zip）共用这一段 —— 三个坑（不 revoke、
 * 不 append 到 body、MIME 大小写）在两条路径上一模一样，不能各写一份。
 */
export function downloadBlob(blob: Blob, filename: string): boolean {
  try {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    return true;
  } catch {
    return false;
  }
}

/**
 * 触发浏览器下载一段文本，返回是否成功。
 *
 * 为什么必须收口到一个函数：这三步每步都有坑，各页面各写一遍必然有人漏。
 * 1. `URL.createObjectURL` 不 revoke 就是内存泄漏（单文件应用开一天会积很多）；
 * 2. `<a>` 必须 append 到 body 再 click，否则 Firefox 不触发下载；
 * 3. MIME 里带 charset，否则部分环境把中文当 latin-1 解。
 */
export function downloadText(text: string, mime: string, filename: string): boolean {
  return downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}

/** UTF-8 编码成字节（便携包 zip 需要原始字节） */
export function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 两位补零（日期、时分） */
export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 数字输入解析：空字符串返回 undefined */
export function parseNumberInput(value: string, fallback?: number): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

/** 安全渲染：把 undefined / null / 空串统一成占位符 */
export function orDash(value?: string | number | null, placeholder = '—'): string {
  if (value === undefined || value === null || value === '') return placeholder;
  return String(value);
}

/**
 * v0.7：把任意字符串变成可安全渲染成 <a href> 的 URL，不安全返回 null。
 * jdUrl 来自 CSV 导入与同步信封，是不可信输入 —— `javascript:` 之类的
 * 危险协议必须挡在渲染层；只放行 http/https。
 */
export function safeHref(raw: string | undefined | null): string | null {
  const value = (raw || '').trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}
