/**
 * 适配器注册表。
 * 加一个平台 = 这里加一行 + 建一个目录（不改任何组件）。
 */

import type { PlatformId } from '../types';
import type { SyncAdapter } from './types';
import { bossAdapter } from './boss/adapter';
import { shixisengAdapter } from './shixiseng/adapter';
import { nowcoderAdapter } from './nowcoder/adapter';
import { customAdapter } from './custom/adapter';

/** 顺序 = 下拉框顺序 = URL 命中优先级 */
export const ADAPTERS: SyncAdapter[] = [
  bossAdapter,
  shixisengAdapter,
  nowcoderAdapter,
  customAdapter,
];

export function adapterById(id: PlatformId): SyncAdapter | null {
  return ADAPTERS.find((adapter) => adapter.id === id) ?? null;
}

export function adapterForUrl(url: string | undefined): SyncAdapter | null {
  if (!url) return null;
  return ADAPTERS.find((adapter) => adapter.matchUrl?.(url) === true) ?? null;
}

/** 超 6 个月未验证 → UI 标「⚠️ 可能已失效」（标但不阻断） */
export function isAdapterStale(adapter: SyncAdapter, now: string): boolean {
  const months = (Date.parse(now) - Date.parse(adapter.lastVerifiedAt)) / (30 * 24 * 3600 * 1000);
  return months > 6;
}

/** 给 UI 用的平台名（含未注册平台的兜底文案） */
export const PLATFORM_LABEL: Record<PlatformId, string> = {
  boss: 'BOSS 直聘',
  shixiseng: '实习僧',
  nowcoder: '牛客',
  custom: '通用表格',
};
