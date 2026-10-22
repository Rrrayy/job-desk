/**
 * AI 能力层类型（v0.8 / T03）。
 *
 * ★ 纪律：数据模型的 AISettings / AISuggestion / RequestLog 定义在 `src/types.ts`
 *   （迁移与校验都依赖那份定义），这里只 **re-export**，绝不写第二份 ——
 *   两份定义必然漂移，漂移的第一个受害者就是校验器。
 */

import type { AISettings, AISuggestion, AISuggestionStatus, AISuggestionTargetType, RequestLog } from '../types';

export type { AISettings, AISuggestion, AISuggestionStatus, AISuggestionTargetType, RequestLog };

/** TargetType 全集（枚举只增不改；为 v1.0 预留的值现在不出现） */
export const AI_TARGET_TYPES: readonly AISuggestionTargetType[] = [
  'question',
  'application_note',
  'staging_field',
];

/** OpenAI 兼容 chat/completions 的一条消息 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionOptions {
  messages: ChatMessage[];
  /** 缺省 true（SSE 流式）；显式 false 走一次性 JSON 响应 */
  stream?: boolean;
  /** 流式增量回调（只在 stream:true 时触发） */
  onDelta?: (delta: string) => void;
  /** 调用方取消。与 gateway 内部的双超时计时器共用同一个 AbortController */
  signal?: AbortSignal;
}

export type GatewayErrorCode = 'timeout' | 'network' | 'http' | 'parse';

/** 新建议（入库前的形状；status/createdAt 由 suggestions.createSuggestions 补齐） */
export interface NewAISuggestion {
  pluginId: string;
  targetType: AISuggestionTargetType;
  /** 追加类建议为 null（接受时才新建行） */
  targetId: string | null;
  /** 'text' | 'myAnswer' | 'companyName' | …（逐字段制） */
  fieldPath: string;
  content: string;
  /** D17：证据对照（原文片段） */
  evidence?: string;
}

/**
 * 接受建议的撤销快照（⌘Z 整体回退的最小信息集）。
 * 与 StatusUndo/SyncUndo 同构：只记「这次操作改了什么」，不复制整库。
 */
export interface AiUndoTarget {
  table: 'questions' | 'notes' | 'staging';
  id: string;
  /** 被改的字段名（新建行为空串） */
  field: string;
  /** 字段旧值；undefined = 原本没有这个字段（revert 时要删键而不是写 undefined） */
  prevValue: string | undefined;
  rowExisted: boolean;
  /** rowExisted=false 时的新建行原值（revert 时整行移除） */
  createdRow?: unknown;
}

export interface AiUndo {
  /** 参与本次确认的建议原值（revert 时恢复 status='pending'） */
  suggestions: AISuggestion[];
  targets: AiUndoTarget[];
}

/** D13 发送预览的一个字段行 */
export interface PreviewField {
  /** 与 prompts/插件 fields 声明对齐的英文键（也是 RequestLog 指纹的键） */
  name: string;
  /** UI 展示名 */
  label: string;
  value: string;
  /** 锁定字段：必须发送，勾选框禁用（如 D17 的用户粘贴原文） */
  locked?: boolean;
  /**
   * 显式默认勾选（v0.8 插件字段用）。缺省时按 SEND_PREVIEW_DEFAULT_CHECKED 基线；
   * 内置场景不传 —— 新增出境字段必须默认不勾（PRD 验收 8）。
   */
  defaultChecked?: boolean;
}
