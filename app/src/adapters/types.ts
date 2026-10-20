/**
 * 适配器协议 = 社区契约。
 *
 * 三条不可动摇的边界（架构 D-02 / PRD §B.4）：
 * 1. 适配器**只做解析**：输入是字符串，输出是 NormalizedRecord[]。不碰 storage、不碰 React。
 * 2. 适配器**不解释产品语义**：状态该映射成什么叫「产品语义」，由 lib/sync/statusMap.ts 决定。
 * 3. 适配器**必须是纯函数**：同输入同输出，不读 Date.now()、不读 DOM、不发请求。
 *    时间由调用方通过 ParseContext.now / AdapterInput.capturedAt 注入。
 *
 * 改本文件的任何字段签名 → 协议 MAJOR 变更，必须同步 docs/adapters/README.md。
 */

import type { PlatformId } from '../types';

export type Confidence = 'high' | 'medium' | 'low';

/** 适配器**唯一**的输入：全是字符串。这既是可测性也是可审计性的来源 */
export interface AdapterInput {
  url?: string;
  title?: string;
  /** 页面纯文本（粘贴通道 = 用户 Ctrl+A/C 的内容；扩展通道 = 列表容器 innerText） */
  text: string;
  /** 可选 HTML（当前所有通道都不提供，保留给未来的 DOM 适配器） */
  html?: string;
  /** 抓取时刻 ISO，由调用方注入 */
  capturedAt: string;
}

/** 逐字段置信度：缺省视为 medium */
export type FieldConfidence = Partial<Record<keyof NormalizedRecord, Confidence>>;

/** 一条规范化记录。字段名是**产品语义**，适配器只负责填，不负责解释 */
export interface NormalizedRecord {
  externalId?: string;
  /** 必填：拿不到公司名的行必须落进 unparsed，不许编一个 */
  companyName: string;
  jobTitle?: string;
  city?: string;
  /** 平台原文状态，如「沟通中」「邀请面试」 */
  status?: string;
  /** 与 status 同源，UI 原样展示用 */
  platformStatusText?: string;
  /** ISO。**不许用抓取时刻替代**；拿不到就 undefined */
  lastContactAt?: string;
  salaryText?: string;
  jdUrl?: string;
  /** 原始片段（≤500 字），用于预览表展开、以及用户手工兜底 */
  rawSnippet?: string;
  /** 逐字段置信度，缺省 medium */
  confidence: FieldConfidence;
  /** 整条置信度 = 各字段最小值 */
  overall: Confidence;
}

export interface UnparsedItem {
  /** ≤500 字原文片段 */
  rawSnippet: string;
  /** 说人话的原因，直接显示给用户：「这一行没有公司名」「日期格式不认识」 */
  reason: string;
}

export interface AdapterResult {
  records: NormalizedRecord[];
  /** 解析失败的必须落这里，**不允许静默丢**（PRD §B.9 P0） */
  unparsed: UnparsedItem[];
}

export interface ParseContext {
  /** 注入的「现在」，用于补年份；保证 parse 是纯函数（可测） */
  now: string;
}

export interface SyncAdapter {
  id: PlatformId;
  name: string;
  platform: PlatformId;
  /** 协议版本；协议本身变更时 = MAJOR */
  version: string;
  /** 最后人工验证该平台页面结构的时间；超 6 个月 UI 标「⚠️ 可能已失效」（标但不阻断） */
  lastVerifiedAt: string;
  /** 该页能不能读。URL 命中用这个，不散落在组件里 */
  matchUrl?: (url: string) => boolean;
  /** 人读的 URL 特征，如 'zhipin.com/web/geek/chat'，写进 docs 与错误文案 */
  urlPattern?: string;
  /** 输入形态；paste 与 file 都走 parse，dom 预留 */
  inputType: 'paste' | 'file' | 'dom';
  parse(raw: AdapterInput, ctx: ParseContext): AdapterResult;
}

/** 置信度排序：high > medium > low，用于整体置信度取最小值 */
export const CONFIDENCE_RANK: Record<Confidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** 取两个置信度里更低的那个 */
export function minConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

/** 从逐字段置信度算出整条置信度：缺省 medium，取最小值 */
export function overallOf(confidence: FieldConfidence): Confidence {
  let result: Confidence = 'high';
  for (const key of Object.keys(confidence) as Array<keyof NormalizedRecord>) {
    const value = confidence[key];
    if (!value) continue;
    result = minConfidence(result, value);
  }
  return result;
}
