/**
 * AI 设置的运行时判定（v0.8 / T03）。
 *
 * 数据定义与清洗在 `src/types.ts` + `src/lib/migrate.ts`（normalizeAiSettings），
 * 这里只回答 UI 每帧都要问的两个问题：
 * ①「现在能不能用」—— 不行就诚实置灰 + 一句内联原因，绝不弹错误轰炸（R-AI-5）；
 * ②「这个地址是不是本机」—— 预览弹层要明示「不出公网」（验收 12）。
 */

import type { AISettings } from '../types';

export interface AiReadiness {
  ready: boolean;
  /** ready=false 时给用户看的一句话；ready=true 恒为 null */
  reason: string | null;
}

/**
 * AI 就绪判定：baseURL 与 model 都非空才算配置完。
 * 故意**不**做网络探测 —— 「能不能连上」只有真发请求时才知道，
 * 启动时探测 = 未经用户同意的网络请求，违反零请求承诺（AI 请求只在 D13 确认后发生）。
 */
export function checkAiReady(settings: AISettings | undefined | null): AiReadiness {
  if (!settings || !settings.baseURL.trim()) {
    return { ready: false, reason: '尚未配置 AI 服务地址（设置 → AI 服务）' };
  }
  if (!settings.model.trim()) {
    return { ready: false, reason: '尚未选择模型（设置 → AI 服务）' };
  }
  return { ready: true, reason: null };
}

/** 本机端点判定（127.0.0.1 / localhost / ::1）。预览弹层据此展示「不出公网」 */
export function isLocalBaseUrl(baseURL: string): boolean {
  const match = /^https?:\/\/([^/:?#]+)/i.exec(baseURL.trim());
  if (!match) return false;
  const host = match[1].toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}
