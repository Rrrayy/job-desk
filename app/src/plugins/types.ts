/**
 * 插件 RPC 协议类型（v0.8 / T04，ARCH §1.3）。
 *
 * 信封双向统一：插件 → host 是请求，host → plugin 是 ready/result/推送。
 * `pluginId` 是 host 的权威字段 —— 插件伪造一律按 unknown_plugin 丢弃。
 */

import type { AISuggestionTargetType } from '../types';

export const RPC_VERSION = 1;

/**
 * 权限模型（只增不改）：
 * - `storage`：本插件命名空间的键值读写
 * - `network:<scenario>`：允许走 gateway 发一次 AI 请求（场景键，同时决定审计归类）
 * - `suggest:<targetType>`：允许产出一个方向的 AI 建议（建议制，不直写目标表）
 */
export type PluginPermission = 'storage' | `network:${string}` | `suggest:${AISuggestionTargetType}`;

export type RpcType =
  | 'hello'
  | 'storage_get'
  | 'storage_set'
  | 'storage_delete'
  | 'storage_keys'
  | 'ai_request'
  | 'suggestion_report';

/** host → plugin 的推送/应答类型 */
export type HostRpcType = 'ready' | 'result' | 'ai_chunk' | 'ai_done';

export interface RpcEnvelope<T = unknown> {
  v: typeof RPC_VERSION;
  /** 请求 id，host 原样回传（result 配对）；host 推送复用 requestId */
  id: string;
  /** host 强制以注册表分配 id 为准 */
  pluginId: string;
  /** 双向统一信封：插件侧是 RpcType 子集，host 推送/应答是 HostRpcType */
  type: RpcType | HostRpcType;
  payload: T;
}

export interface AiRequestPayload {
  requestId: string;
  /** 权限清单键（network:<scenario>），同时决定预览标题与审计归类 */
  scenario: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** content 中的数据一律以 {{field:key}} 占位引用 fields；裸数据视为越权字段 */
  fields: PreviewFieldSpec[];
  stream?: boolean;
}

export interface PreviewFieldSpec {
  key: string;
  label: string;
  value: string;
  /** 内置场景必须符合 D13 基线；插件包默认全 false（用户粘贴项除外） */
  defaultChecked: boolean;
  /** 用户粘贴内容：锁定勾选 */
  locked?: boolean;
}

export type RpcErrorCode =
  | 'unknown_plugin'
  | 'bad_envelope'
  | 'permission_denied'
  /** 占位符残留 / 引用了未确认字段（D16 第 4 类） */
  | 'field_mismatch'
  | 'storage_quota'
  | 'ai_disabled'
  | 'ai_failed'
  | 'timeout'
  | 'unsupported';

/** 插件单条消息（hello）与注册表共用的登记形状 */
export interface PluginManifest {
  name: string;
  version: string;
  permissions: PluginPermission[];
}

/** 注册表条目（持久化在 pluginStorage 的 host 命名空间里） */
export interface PluginRegistration {
  pluginId: string;
  name: string;
  version: string;
  /** 清单声明的权限（展示用；实际授予看 granted） */
  permissions: PluginPermission[];
  enabled: boolean;
  /** 用户逐项授权的集合，可能是声明的子集 */
  granted: PluginPermission[];
}
