// @vitest-environment jsdom
/**
 * `AiSettingsPanel` 交互测试（v0.10 / L1）。
 *
 * 验收口径来自 `docs/AI-S-STANDARD.md` 的 L1-1 / L1-2 / L1-3 / L1-4：
 * - 预设必须真的把 baseURL 与 isLocal 写进 settings（不能只是换个按钮颜色）
 * - 「测试连接」必须走 `api.ai.probe`（而不是组件自己 fetch —— 那会破单点出口）
 * - 参数留空必须是**删除键**，不是写 0（写 0 会把温度锁死在 0 度）
 * - 上次探活的模型列表要能下拉，且不强迫用户选
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppApi } from '../../lib/api';
import type { AISettings, RequestLog } from '../../types';
import type { ProbeResult } from '../../ai/types';
import { emptyDB } from '../../lib/defaults';
import { AiSettingsPanel } from './AiSettingsPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeApi(
  ai: AISettings | undefined,
  options: { logs?: RequestLog[]; probe?: () => Promise<ProbeResult> } = {},
): AppApi {
  const db = emptyDB();
  if (ai) db.settings.ai = ai;
  if (options.logs) db.requestLog = options.logs;
  return {
    db,
    updateSettings: vi.fn(),
    ai: {
      ready: Boolean(ai?.baseURL && ai?.model),
      readyReason: ai?.baseURL ? null : '尚未配置 AI 服务地址（设置 → AI 服务）',
      clearRequestLog: vi.fn(),
      probe: vi.fn(
        options.probe ??
          (async () => ({ ok: true, latencyMs: 42, models: ['qwen2.5:7b'], via: 'models' }) as ProbeResult),
      ),
    },
  } as unknown as AppApi;
}

let root: Root | null = null;
let container: HTMLElement | null = null;

function mount(api: AppApi): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<AiSettingsPanel api={api} />));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

/** React 受控控件的原生写入（直接赋值不会触发 onChange） */
function setValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** 失焦写回：React 17+ 的 onBlur 实际监听 focusout */
function blur(el: HTMLElement): void {
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
}

function byTestId<T extends HTMLElement>(id: string): T {
  const el = container?.querySelector<T>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`找不到 [data-testid="${id}"]`);
  return el;
}

function buttonByText(text: string): HTMLButtonElement {
  const el = [...(container?.querySelectorAll('button') ?? [])].find((button) =>
    button.textContent?.includes(text),
  );
  if (!el) throw new Error(`找不到按钮：${text}`);
  return el;
}

/** 取 updateSettings 最近一次的 ai 载荷 */
function lastAi(api: AppApi): AISettings {
  const calls = (api.updateSettings as unknown as { mock: { calls: Array<[{ ai: AISettings }]> } }).mock.calls;
  return calls[calls.length - 1][0].ai;
}

describe('AiSettingsPanel · 预设与连通性', () => {
  it('未配置：给内联原因，没地址时「测试连接」禁用', () => {
    mount(makeApi(undefined));
    expect(container?.textContent).toContain('尚未配置 AI 服务地址');
    expect(byTestId<HTMLButtonElement>('ai-probe').disabled).toBe(true);
  });

  it('八家厂商预设全部渲染（少一家就是没做完）', () => {
    mount(makeApi(undefined));
    const labels = [...(container?.querySelectorAll('.ai-presets button') ?? [])].map((b) => b.textContent);
    expect(labels).toHaveLength(7);
    for (const key of ['Ollama 本地', 'LM Studio', 'vLLM / 自建', 'DeepSeek', '阿里百炼', '硅基流动', 'OpenAI']) {
      expect(labels).toContain(key);
    }
  });

  it('点「DeepSeek」→ 写入云端地址，且 isLocal=false', () => {
    const api = makeApi(undefined);
    mount(api);
    act(() => buttonByText('DeepSeek').click());
    const ai = lastAi(api);
    expect(ai.baseURL).toBe('https://api.deepseek.com/v1');
    expect(ai.isLocal).toBe(false);
  });

  it('点「Ollama 本地」→ isLocal=true（预览据此说「不出公网」）', () => {
    const api = makeApi(undefined);
    mount(api);
    act(() => buttonByText('Ollama 本地').click());
    const ai = lastAi(api);
    expect(ai.baseURL).toBe('http://127.0.0.1:11434/v1');
    expect(ai.isLocal).toBe(true);
  });

  it('测试连接成功 → 显示延迟与模型数，且只调用一次 probe', async () => {
    const api = makeApi({ baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', isLocal: true });
    mount(api);
    await act(async () => {
      byTestId<HTMLButtonElement>('ai-probe').click();
    });
    expect(api.ai.probe).toHaveBeenCalledTimes(1);
    const line = byTestId('ai-probe-result').textContent ?? '';
    expect(line).toContain('连通');
    expect(line).toContain('42ms');
    expect(line).toContain('1 个模型可用');
  });

  it('测试连接失败 → 原样给出人话原因（不是 undefined）', async () => {
    const api = makeApi(
      { baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', isLocal: true },
      {
        probe: async () => ({
          ok: false,
          latencyMs: 30,
          models: [],
          code: 'auth',
          error: '密钥无效或没有权限 —— 检查 API Key 是否正确',
        }),
      },
    );
    mount(api);
    await act(async () => {
      byTestId<HTMLButtonElement>('ai-probe').click();
    });
    expect(byTestId('ai-probe-result').textContent).toContain('密钥无效');
  });
});

describe('AiSettingsPanel · 模型下拉与生成参数', () => {
  it('上次探活拿到的模型进入 datalist（仍可手填）', () => {
    mount(
      makeApi({
        baseURL: 'http://127.0.0.1:11434/v1',
        model: 'qwen2.5:7b',
        isLocal: true,
        lastCheck: { at: '2026-11-09T08:00:00.000Z', ok: true, latencyMs: 40, models: ['qwen2.5:7b', 'llama3:8b'] },
      }),
    );
    const options = [...(container?.querySelectorAll('#ai-model-options option') ?? [])].map((o) =>
      (o as HTMLOptionElement).value,
    );
    expect(options).toEqual(['qwen2.5:7b', 'llama3:8b']);
    expect(byTestId<HTMLInputElement>('ai-model').getAttribute('list')).toBe('ai-model-options');
  });

  it('温度填 0.5 后失焦 → 写入 temperature: 0.5', () => {
    const api = makeApi({ baseURL: 'http://x/v1', model: 'm', isLocal: false });
    mount(api);
    const input = byTestId<HTMLInputElement>('ai-temperature');
    setValue(input, '0.5');
    act(() => blur(input));
    expect(lastAi(api).temperature).toBe(0.5);
  });

  it('温度清空 → 删除这个键（不是写 0）', () => {
    const api = makeApi({ baseURL: 'http://x/v1', model: 'm', isLocal: false, temperature: 0.9 });
    mount(api);
    const input = byTestId<HTMLInputElement>('ai-temperature');
    setValue(input, '');
    act(() => blur(input));
    expect('temperature' in lastAi(api)).toBe(false);
  });

  it('JSON 模式选「关闭」→ jsonMode=off（给不认 response_format 的服务）', () => {
    const api = makeApi({ baseURL: 'http://x/v1', model: 'm', isLocal: false });
    mount(api);
    const select = byTestId<HTMLSelectElement>('ai-json-mode');
    setValue(select, 'off');
    expect(lastAi(api).jsonMode).toBe('off');
  });

  it('超时填 90 秒 → timeoutSec=90', () => {
    const api = makeApi({ baseURL: 'http://x/v1', model: 'm', isLocal: false });
    mount(api);
    const input = byTestId<HTMLInputElement>('ai-timeout');
    setValue(input, '90');
    act(() => blur(input));
    expect(lastAi(api).timeoutSec).toBe(90);
  });
});

describe('AiSettingsPanel · 用量回显', () => {
  it('累计 tokens 与最近失败原因都能看见', () => {
    const logs: RequestLog[] = [
      {
        id: 'r1',
        timestamp: '2026-11-09T08:00:00.000Z',
        pluginId: 'builtin:d14',
        baseUrl: 'http://x/v1',
        model: 'm',
        sentFieldsHash: 'h1',
        status: 'ok',
        tokens: { prompt: 800, completion: 400, total: 1200 },
      },
      {
        id: 'r2',
        timestamp: '2026-11-09T08:05:00.000Z',
        pluginId: 'builtin:d15',
        baseUrl: 'http://x/v1',
        model: 'm',
        sentFieldsHash: 'h2',
        status: 'error',
        errorCode: 'rate_limit',
      },
    ];
    mount(makeApi({ baseURL: 'http://x/v1', model: 'm', isLocal: false }, { logs }));
    const text = byTestId('ai-usage').textContent ?? '';
    expect(text).toContain('成功 1 次');
    expect(text).toContain('1.2k tokens');
    expect(text).toContain('rate_limit');
  });
});
