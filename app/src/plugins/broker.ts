/**
 * RPC broker（v0.8 / T04，ARCH §1.3）—— 插件与宿主之间的唯一通道。
 *
 * host 侧五项强制（全部在本文件，D16 逐类测试）：
 * ① `event.source` 必须等于该插件 iframe 的 contentWindow（防别的窗口冒充）；
 * ② 信封 pluginId 必须等于注册表分配 id（hello 例外：握手前插件还不知道 id，
 *    靠 source 反查）；③ storage 逻辑键由 host 拼物理前缀，插件无法跨命名空间；
 * ④ ai_request 先走 D13 预览，确认后做 {{field:key}} 占位符替换 + 一致性校验，
 *    残留/未声明/未确认 → 拒绝发送并记日志；⑤ 每次真实发送由 sendAi 依赖记账。
 *
 * broker 不碰 fetch、不碰库：数据面全部经 deps 注入，单测用假依赖即可覆盖。
 */

import type { ChatMessage, PreviewField } from '../ai/types';
import type { NewAISuggestion } from '../ai/types';
import {
  RPC_VERSION,
  type AiRequestPayload,
  type PluginPermission,
  type PluginRegistration,
  type RpcEnvelope,
  type RpcErrorCode,
  type RpcType,
} from './types';
import { isReservedPluginKey, isValidPluginKey } from './storage';

const REQUEST_TYPES: readonly RpcType[] = [
  'hello',
  'storage_get',
  'storage_set',
  'storage_delete',
  'storage_keys',
  'ai_request',
  'suggestion_report',
];

const PLACEHOLDER_RE = /\{\{field:([A-Za-z0-9_]+)\}\}/g;

export interface SendAiInput {
  pluginId: string;
  requestId: string;
  scenario: string;
  /** 已完成占位符替换的最终消息（真实出境内容） */
  messages: ChatMessage[];
  /** 用户确认勾选的字段（指纹与日志的数据源） */
  checked: Record<string, string>;
  stream: boolean;
}

export interface BrokerDeps {
  listPlugins(): PluginRegistration[];
  /** 该插件 iframe 的 contentWindow（null = iframe 尚未挂载） */
  windowOf(pluginId: string): unknown | null;
  post(pluginId: string, envelope: RpcEnvelope): void;
  storageGet(pluginId: string, key: string): unknown | null;
  storageSet(pluginId: string, key: string, value: unknown): RpcErrorCode | null;
  storageDelete(pluginId: string, key: string): void;
  storageKeys(pluginId: string): string[];
  aiReady(): boolean;
  aiConfig(): { baseURL: string; model: string; isLocal: boolean } | null;
  /** 弹 D13 预览；resolve(null) = 用户取消 */
  openPreview(input: { pluginId: string; scenario: string; fields: PreviewField[] }): Promise<Record<string, string> | null>;
  /** 真实发送：gateway 调用 + RequestLog 记账 + ai_chunk/ai_done 推送（App 实现） */
  sendAi(input: SendAiInput): Promise<{ text: string } | null>;
  /** 发送被拒绝时的记账（status=error + errorCode，原文永不落日志） */
  logRefusal(pluginId: string, scenario: string, errorCode: RpcErrorCode): void;
  reportSuggestions(pluginId: string, list: NewAISuggestion[]): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 非法信封统一静默丢弃（不给探测者回音），返回 null 表示「不值得回信」 */
export function validateEnvelope(data: unknown): RpcEnvelope | null {
  if (!isRecord(data)) return null;
  if (data.v !== RPC_VERSION) return null;
  if (typeof data.id !== 'string' || data.id.length === 0 || data.id.length > 64) return null;
  if (typeof data.pluginId !== 'string' || data.pluginId.length > 80) return null;
  if (typeof data.type !== 'string' || !(REQUEST_TYPES as readonly string[]).includes(data.type)) return null;
  if (!('payload' in data)) return null;
  return data as unknown as RpcEnvelope;
}

export class PluginBroker {
  constructor(private readonly deps: BrokerDeps) {}

  /** window message 监听器的处理入口。event 只需 { source, data } 形状 */
  handleEvent(event: { source: unknown; data: unknown }): void {
    const envelope = validateEnvelope(event.data);
    if (!envelope) return;

    const plugins = this.deps.listPlugins();
    // ①+②：hello 靠 source 反查（握手前插件不知道自己的 id）；其余类型双重校验
    let registration: PluginRegistration | undefined;
    if (envelope.type === 'hello') {
      registration = plugins.find((item) => this.deps.windowOf(item.pluginId) === event.source);
    } else {
      registration = plugins.find((item) => item.pluginId === envelope.pluginId);
      if (!registration || this.deps.windowOf(registration.pluginId) !== event.source) {
        this.fail(registration?.pluginId ?? envelope.pluginId, envelope.id, 'unknown_plugin', '插件未注册或来源不符');
        return;
      }
    }
    if (!registration) return; // 来源不属于任何注册插件：静默丢弃

    switch (envelope.type) {
      case 'hello':
        this.onHello(registration, envelope);
        return;
      case 'storage_get':
      case 'storage_set':
      case 'storage_delete':
      case 'storage_keys':
        this.onStorage(registration, envelope);
        return;
      case 'ai_request':
        void this.onAiRequest(registration, envelope);
        return;
      case 'suggestion_report':
        this.onSuggestionReport(registration, envelope);
        return;
      default:
        return;
    }
  }

  private reply(pluginId: string, id: string, data: { ok: true; data: unknown } | { ok: false; code: RpcErrorCode; message: string }): void {
    this.deps.post(pluginId, { v: RPC_VERSION, id, pluginId, type: 'result', payload: data });
  }

  private fail(pluginId: string, id: string, code: RpcErrorCode, message: string): void {
    this.reply(pluginId, id, { ok: false, code, message });
  }

  private onHello(registration: PluginRegistration, envelope: RpcEnvelope): void {
    // 清单一致性：插件自报的 name/version 必须与注册时解析的 manifest 一致
    const payload = envelope.payload as { name?: unknown; version?: unknown } | null;
    if (!isRecord(payload) || payload.name !== registration.name || payload.version !== registration.version) {
      this.fail(registration.pluginId, envelope.id, 'bad_envelope', 'hello 与注册清单不一致');
      return;
    }
    this.deps.post(registration.pluginId, {
      v: RPC_VERSION,
      id: envelope.id,
      pluginId: registration.pluginId,
      type: 'ready',
      payload: { pluginId: registration.pluginId, grantedPermissions: registration.granted },
    });
  }

  private granted(registration: PluginRegistration, permission: PluginPermission): boolean {
    return registration.enabled && registration.granted.includes(permission);
  }

  private onStorage(registration: PluginRegistration, envelope: RpcEnvelope): void {
    const pluginId = registration.pluginId;
    if (!this.granted(registration, 'storage')) {
      this.fail(pluginId, envelope.id, 'permission_denied', '未授予 storage 权限');
      return;
    }
    const payload = isRecord(envelope.payload) ? envelope.payload : null;
    switch (envelope.type) {
      case 'storage_get': {
        const key = payload?.key;
        if (!isValidPluginKey(key)) return this.fail(pluginId, envelope.id, 'bad_envelope', 'key 不合法');
        if (isReservedPluginKey(key)) return this.fail(pluginId, envelope.id, 'permission_denied', 'host 保留键不可读');
        this.reply(pluginId, envelope.id, { ok: true, data: this.deps.storageGet(pluginId, key) });
        return;
      }
      case 'storage_set': {
        const key = payload?.key;
        if (!isValidPluginKey(key) || !('value' in (payload as Record<string, unknown>))) {
          return this.fail(pluginId, envelope.id, 'bad_envelope', 'key/value 不合法');
        }
        if (isReservedPluginKey(key)) return this.fail(pluginId, envelope.id, 'permission_denied', 'host 保留键不可写');
        const error = this.deps.storageSet(pluginId, key, (payload as Record<string, unknown>).value);
        if (error) return this.fail(pluginId, envelope.id, error, error === 'storage_quota' ? '单条超过 256 KB' : '载荷不合规');
        this.reply(pluginId, envelope.id, { ok: true, data: null });
        return;
      }
      case 'storage_delete': {
        const key = payload?.key;
        if (!isValidPluginKey(key)) return this.fail(pluginId, envelope.id, 'bad_envelope', 'key 不合法');
        if (isReservedPluginKey(key)) return this.fail(pluginId, envelope.id, 'permission_denied', 'host 保留键不可删');
        this.deps.storageDelete(pluginId, key);
        this.reply(pluginId, envelope.id, { ok: true, data: null });
        return;
      }
      case 'storage_keys':
        this.reply(pluginId, envelope.id, {
          ok: true,
          data: this.deps.storageKeys(pluginId).filter((key) => !isReservedPluginKey(key)),
        });
        return;
      default:
        return;
    }
  }

  /** ai_request：权限 → 就绪 → D13 预览 → 占位符一致性校验 → 代理发送 */
  private async onAiRequest(registration: PluginRegistration, envelope: RpcEnvelope): Promise<void> {
    const pluginId = registration.pluginId;
    const payload = envelope.payload as AiRequestPayload | null;
    if (
      !isRecord(payload) ||
      typeof payload.requestId !== 'string' ||
      typeof payload.scenario !== 'string' ||
      !Array.isArray(payload.messages) ||
      !Array.isArray(payload.fields)
    ) {
      return this.fail(pluginId, envelope.id, 'bad_envelope', 'ai_request 载荷不完整');
    }
    const permission: PluginPermission = `network:${payload.scenario}`;
    if (!this.granted(registration, permission)) {
      return this.fail(pluginId, envelope.id, 'permission_denied', `未授予 network:${payload.scenario} 权限`);
    }
    const config = this.deps.aiConfig();
    if (!this.deps.aiReady() || !config) {
      return this.fail(pluginId, envelope.id, 'ai_disabled', 'AI 服务未配置');
    }

    // D13 预览（插件字段 defaultChecked 由插件声明；locked 由用户粘贴项决定）
    const fields: PreviewField[] = payload.fields.map((field) => ({
      name: field.key,
      label: field.label,
      value: field.value,
      ...(field.locked ? { locked: true } : {}),
    }));
    const checked = await this.deps.openPreview({ pluginId, scenario: payload.scenario, fields });
    if (checked === null) {
      return this.fail(pluginId, envelope.id, 'permission_denied', '用户在发送预览中取消了本次请求');
    }

    // ④ 一致性校验：引用未声明字段 / 未确认字段 / 替换后残留 → 拒发 + 记日志
    const declared = new Set(payload.fields.map((field) => field.key));
    const problem = this.findFieldMismatch(payload.messages, declared, checked);
    if (problem) {
      this.deps.logRefusal(pluginId, payload.scenario, 'field_mismatch');
      return this.fail(pluginId, envelope.id, 'field_mismatch', `请求体与预览不一致：${problem}`);
    }

    const messages: ChatMessage[] = payload.messages.map((message) => ({
      role: message.role,
      content: this.substituteFields(message.content, checked),
    }));

    try {
      if (payload.stream === true) {
        // 流式：ai_chunk / ai_done 推送由 sendAi 依赖负责（envelope id 复用 requestId）
        await this.deps.sendAi({
          pluginId,
          requestId: payload.requestId,
          scenario: payload.scenario,
          messages,
          checked,
          stream: true,
        });
        return;
      }
      const result = await this.deps.sendAi({
        pluginId,
        requestId: payload.requestId,
        scenario: payload.scenario,
        messages,
        checked,
        stream: false,
      });
      this.reply(pluginId, envelope.id, { ok: true, data: { text: result?.text ?? '' } });
    } catch (error) {
      this.fail(pluginId, envelope.id, 'ai_failed', error instanceof Error ? error.message : String(error));
    }
  }

  /** 返回第一处不一致的描述；null = 一致 */
  findFieldMismatch(
    messages: ChatMessage[],
    declared: ReadonlySet<string>,
    checked: Readonly<Record<string, string>>,
  ): string | null {
    for (const message of messages) {
      const referenced = new Set<string>();
      let match: RegExpExecArray | null;
      PLACEHOLDER_RE.lastIndex = 0;
      while ((match = PLACEHOLDER_RE.exec(message.content)) !== null) {
        referenced.add(match[1]);
      }
      for (const key of referenced) {
        if (!declared.has(key)) return `引用了未声明字段 ${key}`;
        if (!(key in checked)) return `引用了未确认字段 ${key}`;
      }
    }
    // 替换后再查残留：content 里手工写的 {{field:xxx}} 不在占位符语法位置也拦下
    for (const message of messages) {
      const replaced = this.substituteFields(message.content, checked);
      if (replaced.includes('{{field:')) return '存在无法替换的占位符残留';
    }
    return null;
  }

  /** {{field:key}} → 确认值；未确认的键保持原样（残留由校验拦下） */
  substituteFields(content: string, checked: Readonly<Record<string, string>>): string {
    return content.replace(PLACEHOLDER_RE, (whole, key: string) => (key in checked ? checked[key] : whole));
  }

  private onSuggestionReport(registration: PluginRegistration, envelope: RpcEnvelope): void {
    const pluginId = registration.pluginId;
    const list = envelope.payload;
    if (!Array.isArray(list) || list.length === 0) {
      return this.fail(pluginId, envelope.id, 'bad_envelope', 'suggestion_report 需要非空数组');
    }
    if (list.length > 50) {
      return this.fail(pluginId, envelope.id, 'bad_envelope', '单次建议不得超过 50 条');
    }
    // 逐条权限：任何一条缺对应 suggest:<targetType> 授权，整批拒绝（不给半写状态）
    for (const item of list) {
      const targetType = isRecord(item) ? item.targetType : null;
      if (typeof targetType !== 'string') {
        return this.fail(pluginId, envelope.id, 'bad_envelope', '建议缺少 targetType');
      }
      if (!this.granted(registration, `suggest:${targetType}` as PluginPermission)) {
        return this.fail(pluginId, envelope.id, 'permission_denied', `未授予 suggest:${targetType} 权限`);
      }
    }
    this.deps.reportSuggestions(
      pluginId,
      list.map((item) => item as NewAISuggestion),
    );
    this.reply(pluginId, envelope.id, { ok: true, data: { count: list.length } });
  }
}
