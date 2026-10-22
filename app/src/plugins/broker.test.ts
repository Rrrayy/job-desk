/**
 * RPC broker 单测（v0.8 / T04，ARCH §1.3 host 侧五项强制 + D16）。
 * 数据面全部走假依赖，不碰真实库与网络。
 */

import { describe, expect, it } from 'vitest';
import { PluginBroker, validateEnvelope, type BrokerDeps, type SendAiInput } from './broker';
import { PLUGIN_HTML_KEY } from './storage';
import { RPC_VERSION, type PluginRegistration, type RpcEnvelope } from './types';

const PID = 'plugin:demo';
const WIN = { mark: 'iframe-window' };

function makeDeps(overrides: Partial<BrokerDeps> = {}) {
  const replies: RpcEnvelope[] = [];
  const sent: SendAiInput[] = [];
  const refusals: Array<{ pluginId: string; code: string }> = [];
  const suggestionBatches: unknown[][] = [];
  const registry: PluginRegistration[] = [
    {
      pluginId: PID,
      name: 'Demo',
      version: '1.0.0',
      permissions: ['storage', 'network:demo', 'suggest:application_note'],
      enabled: true,
      granted: ['storage', 'network:demo', 'suggest:application_note'],
    },
    {
      pluginId: 'plugin:other',
      name: 'Other',
      version: '1.0.0',
      permissions: ['storage'],
      enabled: true,
      granted: ['storage'],
    },
  ];
  const deps: BrokerDeps = {
    listPlugins: () => registry,
    windowOf: (pluginId) => (pluginId === PID ? WIN : pluginId === 'plugin:other' ? { mark: 'other' } : null),
    post: (_pluginId, envelope) => replies.push(envelope),
    storageGet: () => null,
    storageSet: () => null,
    storageDelete: () => undefined,
    storageKeys: () => [],
    aiReady: () => true,
    aiConfig: () => ({ baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen', isLocal: true }),
    openPreview: async () => ({ note: '用户确认的值' }),
    sendAi: async (input) => {
      sent.push(input);
      return { text: 'ok-text' };
    },
    logRefusal: (pluginId, _scenario, code) => refusals.push({ pluginId, code }),
    reportSuggestions: (_pluginId, list) => suggestionBatches.push(list),
    ...overrides,
  };
  const broker = new PluginBroker(deps);
  const call = (type: string, payload: unknown, opts: { pluginId?: string; source?: unknown; id?: string } = {}) =>
    broker.handleEvent({
      source: opts.source ?? WIN,
      data: { v: RPC_VERSION, id: opts.id ?? 'r1', pluginId: opts.pluginId ?? PID, type, payload },
    });
  return { broker, replies, sent, refusals, suggestionBatches, registry, call };
}

const resultOf = (replies: RpcEnvelope[], index = 0) => replies[index]?.payload as Record<string, unknown>;

describe('broker · 信封与来源（D16 防伪造）', () => {
  it('validateEnvelope：v/type/id/pluginId 任一不合规都拒', () => {
    expect(validateEnvelope({ v: 2, id: 'a', pluginId: 'p', type: 'hello', payload: null })).toBeNull();
    expect(validateEnvelope({ v: 1, id: '', pluginId: 'p', type: 'hello', payload: null })).toBeNull();
    expect(validateEnvelope({ v: 1, id: 'a', pluginId: 'p', type: 'self_fetch', payload: null })).toBeNull();
    expect(validateEnvelope({ v: 1, id: 'a', pluginId: 'p', type: 'hello' })).toBeNull();
    expect(validateEnvelope('hello')).toBeNull();
    expect(validateEnvelope({ v: 1, id: 'a', pluginId: 'p', type: 'hello', payload: {} })).not.toBeNull();
  });

  it('★ 信封 pluginId 不在注册表 → unknown_plugin，不派发', () => {
    const { replies, call } = makeDeps();
    call('storage_get', { key: 'k' }, { pluginId: 'plugin:ghost' });
    expect(resultOf(replies)).toMatchObject({ ok: false, code: 'unknown_plugin' });
  });

  it('★ 冒充已注册 id 但 source 不匹配 → unknown_plugin（五强制 ①+②）', () => {
    const { replies, call } = makeDeps();
    call('storage_get', { key: 'k' }, { source: { mark: 'evil-window' } });
    expect(resultOf(replies)).toMatchObject({ ok: false, code: 'unknown_plugin' });
  });

  it('hello：靠 source 反查（握手前不知道 id），回 ready + 实际授权集', () => {
    const { replies, call } = makeDeps();
    call('hello', { name: 'Demo', version: '1.0.0' }, { pluginId: '?', id: 'hello-1' });
    expect(replies[0]).toMatchObject({ type: 'ready', pluginId: PID, id: 'hello-1' });
    expect((replies[0].payload as { grantedPermissions: string[] }).grantedPermissions).toContain('network:demo');
  });

  it('hello 自报 name/version 与注册清单不符 → bad_envelope', () => {
    const { replies, call } = makeDeps();
    call('hello', { name: 'Demo', version: '9.9.9' });
    expect(resultOf(replies)).toMatchObject({ ok: false, code: 'bad_envelope' });
  });
});

describe('broker · storage', () => {
  it('无 storage 权限 → permission_denied', () => {
    const { replies, call } = makeDeps({
      listPlugins: () => [
        { pluginId: PID, name: 'Demo', version: '1.0.0', permissions: ['storage'], enabled: true, granted: [] },
      ],
    });
    call('storage_get', { key: 'k' });
    expect(resultOf(replies)).toMatchObject({ ok: false, code: 'permission_denied' });
  });

  it('disabled 插件即使有授权也拒（enabled && granted 双条件）', () => {
    const { replies, call } = makeDeps({
      listPlugins: () => [
        { pluginId: PID, name: 'Demo', version: '1.0.0', permissions: ['storage'], enabled: false, granted: ['storage'] },
      ],
    });
    call('storage_keys', null);
    expect(resultOf(replies)).toMatchObject({ ok: false, code: 'permission_denied' });
  });

  it('key 不合法 → bad_envelope；合法键交给 deps（含 keys/get/set/delete 分发）', () => {
    const setCalls: Array<[string, unknown]> = [];
    const { replies, call } = makeDeps({
      storageSet: (pluginId, key, value) => {
        setCalls.push([`${pluginId}::${key}`, value]);
        return null;
      },
    });
    call('storage_set', { key: 'a::b', value: 1 });
    expect(resultOf(replies)).toMatchObject({ ok: false, code: 'bad_envelope' });

    call('storage_set', { key: 'k', value: 42 });
    expect(setCalls[0]).toEqual([`${PID}::k`, 42]);
    expect(resultOf(replies, 1)).toMatchObject({ ok: true });
  });
});

describe('broker · host 保留键（D16 第 3 类的边界）', () => {
  it('插件读写 host.bundle 一律拒绝，且不触达 deps', () => {
    let touched = 0;
    const { replies, call } = makeDeps({
      storageGet: () => { touched += 1; return null; },
      storageSet: () => { touched += 1; return null; },
      storageDelete: () => { touched += 1; },
    });
    call('storage_get', { key: PLUGIN_HTML_KEY });
    call('storage_set', { key: PLUGIN_HTML_KEY, value: 'x' });
    call('storage_delete', { key: PLUGIN_HTML_KEY });
    for (let i = 0; i < replies.length; i += 1) {
      expect(resultOf(replies, i)).toMatchObject({ ok: false, code: 'permission_denied' });
    }
    expect(touched).toBe(0);
  });

  it('storage_keys 过滤掉 host 保留键（不把宿主资产暴露给插件）', () => {
    const { replies, call } = makeDeps({
      storageKeys: () => ['notes', PLUGIN_HTML_KEY],
    });
    call('storage_keys', null);
    expect(resultOf(replies)).toMatchObject({ ok: true, data: ['notes'] });
  });
});

describe('broker · ai_request（D16 第 1/4 类）', () => {
  const payload = {
    requestId: 'ai-1',
    scenario: 'demo',
    fields: [{ key: 'note', label: '笔记', value: '原始值', defaultChecked: false }],
    messages: [{ role: 'user' as const, content: '整理：{{field:note}}' }],
  };

  it('★ 未声明 network:<scenario> 权限 → permission_denied，不预览不发送', async () => {
    let previewOpened = false;
    const { replies, sent, call } = makeDeps({
      openPreview: async () => {
        previewOpened = true;
        return {};
      },
      listPlugins: () => [
        { pluginId: PID, name: 'Demo', version: '1.0.0', permissions: ['network:demo'], enabled: true, granted: [] },
      ],
    });
    call('ai_request', payload);
    await Promise.resolve();
    expect(resultOf(replies)).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(previewOpened).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('AI 未配置 → ai_disabled', async () => {
    const { replies, call } = makeDeps({ aiReady: () => false });
    call('ai_request', payload);
    await Promise.resolve();
    expect(resultOf(replies)).toMatchObject({ ok: false, code: 'ai_disabled' });
  });

  it('★ 引用未声明字段 → field_mismatch + 拒发 + 记拒绝日志', async () => {
    const { replies, sent, refusals, call } = makeDeps({
      openPreview: async () => ({ note: 'x' }),
    });
    call('ai_request', {
      ...payload,
      messages: [{ role: 'user', content: '整理：{{field:ghost}}' }],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resultOf(replies)).toMatchObject({ ok: false, code: 'field_mismatch' });
    expect(sent).toHaveLength(0);
    expect(refusals).toEqual([{ pluginId: PID, code: 'field_mismatch' }]);
  });

  it('★ 引用未确认字段（预览取消勾选）→ field_mismatch，不发送', async () => {
    const { replies, sent, call } = makeDeps({
      openPreview: async () => ({}), // 用户只确认了 0 个字段
    });
    call('ai_request', payload);
    await Promise.resolve();
    await Promise.resolve();
    expect(resultOf(replies)).toMatchObject({ ok: false, code: 'field_mismatch' });
    expect(sent).toHaveLength(0);
  });

  it('★ 确认后占位符替换成功 → sendAi 收到替换后的消息，result 回传文本', async () => {
    const { replies, sent, call } = makeDeps();
    call('ai_request', payload);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(sent[0].messages[0].content).toBe('整理：用户确认的值');
    expect(sent[0].checked).toEqual({ note: '用户确认的值' });
    expect(resultOf(replies)).toEqual({ ok: true, data: { text: 'ok-text' } });
  });

  it('★ 占位符残留（书写了不存在的 {{field:xxx}} 语法）→ field_mismatch', async () => {
    const { replies, sent, call } = makeDeps({
      openPreview: async () => ({ note: 'x' }),
    });
    call('ai_request', {
      ...payload,
      messages: [{ role: 'user', content: '{{field:note}} {{field:不存在}}' }],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resultOf(replies)).toMatchObject({ ok: false, code: 'field_mismatch' });
    expect(sent).toHaveLength(0);
  });

  it('用户取消预览 → 不发送，回 permission_denied', async () => {
    const { replies, sent, call } = makeDeps({ openPreview: async () => null });
    call('ai_request', payload);
    await Promise.resolve();
    await Promise.resolve();
    expect(resultOf(replies)).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(sent).toHaveLength(0);
  });

  it('stream=true：不再回 result（ai_chunk/ai_done 由 sendAi 依赖推送）', async () => {
    const { replies, call } = makeDeps();
    call('ai_request', { ...payload, stream: true });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(replies).toHaveLength(0);
  });
});

describe('broker · suggestion_report', () => {
  const suggestion = { targetType: 'application_note', targetId: null, fieldPath: 'content', content: '草稿' };

  it('★ 有 suggest:<target> 权限 → 整批入库；无权限 → 整批拒（不给半写状态）', () => {
    const { suggestionBatches, replies, call } = makeDeps();
    call('suggestion_report', [suggestion]);
    expect(suggestionBatches).toHaveLength(1);
    expect(resultOf(replies)).toEqual({ ok: true, data: { count: 1 } });

    const { suggestionBatches: batches2, replies: replies2, call: call2 } = makeDeps({
      listPlugins: () => [
        { pluginId: PID, name: 'Demo', version: '1.0.0', permissions: ['suggest:question'], enabled: true, granted: ['suggest:question'] },
      ],
    });
    call2('suggestion_report', [suggestion]);
    expect(batches2).toHaveLength(0);
    expect(resultOf(replies2)).toMatchObject({ ok: false, code: 'permission_denied' });
  });

  it('>50 条 → bad_envelope；disabled → permission_denied', () => {
    const { replies, call } = makeDeps();
    call('suggestion_report', Array.from({ length: 51 }, () => suggestion));
    expect(resultOf(replies)).toMatchObject({ ok: false, code: 'bad_envelope' });
  });
});
