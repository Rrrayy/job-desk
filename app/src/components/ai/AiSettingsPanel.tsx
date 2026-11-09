/**
 * AI 服务设置（v0.8 / T05；v0.10 配置向导）—— 设置抽屉里的「AI 服务（可选）」一段。
 *
 * v0.10 的六件改动（每条对应 L1 一个验收项）：
 * 1. 预设从 2 个扩到 8 个（含云端厂商），点一下只填地址，模型名仍留给用户
 * 2. 「测试连接」按钮：`GET /models` 探活 + 最小 chat 探针，**点击才发请求**
 * 3. 模型名从上次探活结果里下拉，仍可手填（不强制）
 * 4. 生成参数折叠区：温度 / top_p / max_tokens / JSON 模式 / 超时
 * 5. 用量一行：调用次数、累计 tokens、最近一次失败原因
 * 6. 探针结论与错误码人话，直接上屏，不再让用户对着「undefined」猜
 *
 * 仍然不做的两件事（有意）：
 * - **不预填任何地址**：缺省 = 未配置，三个场景入口诚实置灰
 * - **不在启动时探测**：`checkAiReady` 只看 baseURL/model 是否为空
 */

import { useMemo, useState } from 'react';
import type { AppApi } from '../../lib/api';
import type { AISettings } from '../../types';
import type { ProbeResult } from '../../ai/types';
import { isLocalBaseUrl } from '../../ai/settings';
import { CLS } from '../../lib/classTokens';

/** 一键预设：只填地址，模型名留给用户（每台机器/每个账号装的模型不一样） */
const PRESETS: Array<{ label: string; baseURL: string; hint: string }> = [
  { label: 'Ollama 本地', baseURL: 'http://127.0.0.1:11434/v1', hint: '本机' },
  { label: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1', hint: '本机' },
  { label: 'vLLM / 自建', baseURL: 'http://127.0.0.1:8000/v1', hint: '本机' },
  { label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', hint: '云端' },
  { label: '阿里百炼', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', hint: '云端' },
  { label: '硅基流动', baseURL: 'https://api.siliconflow.cn/v1', hint: '云端' },
  { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', hint: '云端' },
];

const EMPTY: AISettings = { baseURL: '', model: '', isLocal: false };

/** token 数的人类写法：1234 → 1.2k */
function fmtTokens(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

/** 用量汇总（纯展示；日志本身最多 200 条，所以这些数有上界，不会无限涨） */
interface Usage {
  calls: number;
  tokens: number;
  lastError: string | null;
}

function summarize(logs: AppApi['db']['requestLog']): Usage {
  let calls = 0;
  let tokens = 0;
  let lastError: string | null = null;
  for (const entry of logs) {
    if (entry.status === 'ok') calls += 1;
    if (entry.tokens) tokens += entry.tokens.total;
    if (entry.status === 'error' && !lastError) lastError = entry.errorCode ?? 'unknown';
  }
  return { calls, tokens, lastError };
}

/** 数值输入：空串 = 删除该参数（回到「不发这个键」），非法值同样删除 */
function numberPatch(raw: string, key: 'temperature' | 'topP' | 'maxTokens' | 'timeoutSec'): Partial<AISettings> {
  const trimmed = raw.trim();
  if (!trimmed) return { [key]: undefined } as Partial<AISettings>;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { [key]: undefined } as Partial<AISettings>;
  return { [key]: value } as Partial<AISettings>;
}

export function AiSettingsPanel({ api }: { api: AppApi }): JSX.Element {
  const ai = api.db.settings.ai ?? EMPTY;
  /** 本地回显：刚点预设时输入框要立刻显示新地址（受控 + 提交进 settings） */
  const [baseURL, setBaseURL] = useState(ai.baseURL);
  const [model, setModel] = useState(ai.model);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);

  const save = (patch: Partial<AISettings>): void => {
    const next: AISettings = { ...ai };
    const bag = next as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      // 显式传 undefined = 删掉这个参数（回到「不发送」），而不是写一个 undefined 进库
      if (value === undefined) delete bag[key];
      else bag[key] = value;
    }
    next.isLocal = isLocalBaseUrl(next.baseURL);
    if (!next.apiKey) delete next.apiKey;
    api.updateSettings({ ai: next });
  };

  const applyPreset = (preset: { baseURL: string }): void => {
    setBaseURL(preset.baseURL);
    setProbe(null);
    save({ baseURL: preset.baseURL });
  };

  const local = isLocalBaseUrl(ai.baseURL);
  const usage = useMemo(() => summarize(api.db.requestLog), [api.db.requestLog]);
  /** 上次探活拿到的模型列表（不是本次会话的临时状态：换台机器再打开也在） */
  const knownModels = ai.lastCheck?.models ?? [];
  const lastCheck = !probe && ai.lastCheck ? ai.lastCheck : null;

  const runProbe = async (): Promise<void> => {
    setProbing(true);
    setProbe(null);
    try {
      setProbe(await api.ai.probe());
    } finally {
      setProbing(false);
    }
  };

  return (
    <div data-testid="ai-settings">
      <p className={api.ai.ready ? 'field__hint' : 'field__hint field__hint--danger'}>
        {api.ai.ready
          ? '已配置：所有场景可用，每次发送前强制预览。'
          : `${api.ai.readyReason ?? 'AI 未配置'}。未配置时入口是灰的，不会弹错误框。`}
      </p>

      <div className="ai-presets" role="group" aria-label="服务预设">
        {PRESETS.map((preset) => (
          <button
            key={preset.baseURL}
            type="button"
            className={CLS.b}
            title={`${preset.baseURL}（${preset.hint}）`}
            onClick={() => applyPreset(preset)}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className={CLS.X}>
        <label className={CLS.g}>
          <span className={CLS.a}>服务地址（含 /v1）</span>
          <input
            className={CLS.f}
            value={baseURL}
            placeholder="http://127.0.0.1:11434/v1"
            data-testid="ai-base-url"
            onChange={(event) => setBaseURL(event.target.value)}
            onBlur={() => save({ baseURL: baseURL.trim() })}
          />
        </label>
        <label className={CLS.e}>
          <span className={CLS.a}>模型名</span>
          <input
            className={CLS.f}
            value={model}
            list="ai-model-options"
            placeholder="qwen2.5:7b"
            data-testid="ai-model"
            onChange={(event) => setModel(event.target.value)}
            onBlur={() => save({ model: model.trim() })}
          />
          <datalist id="ai-model-options">
            {knownModels.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        </label>
        <label className={CLS.e}>
          <span className={CLS.a}>API Key（本地可空）</span>
          <input
            className={CLS.f}
            type="password"
            defaultValue={ai.apiKey ?? ''}
            autoComplete="off"
            placeholder="留空 = 不带 Authorization"
            onBlur={(event) => save({ apiKey: event.target.value.trim() })}
          />
        </label>
      </div>

      <div className={CLS.r}>
        <button
          type="button"
          className={CLS.b}
          onClick={() => void runProbe()}
          disabled={probing || !ai.baseURL.trim()}
          data-testid="ai-probe"
        >
          {probing ? '测试中…' : '测试连接'}
        </button>
        <span className={CLS.c} data-testid="ai-probe-result">
          {probe
            ? probe.ok
              ? `✓ 连通 ${probe.latencyMs}ms${probe.models.length > 0 ? ` · ${probe.models.length} 个模型可用` : ' · 服务未提供模型列表'}`
              : `✗ ${probe.error ?? '连接失败'}`
            : lastCheck
              ? lastCheck.ok
                ? `上次检测：连通 ${lastCheck.latencyMs}ms（${new Date(lastCheck.at).toLocaleString()}）`
                : `上次检测失败：${lastCheck.error ?? '连接失败'}`
              : '点一下确认地址与密钥是否可用（只在你点击时发请求）'}
        </span>
      </div>

      <details className="ai-params">
        <summary className={CLS.k}>生成参数（可选，留空即用服务端默认）</summary>
        <div className={CLS.X}>
          <label className={CLS.e}>
            <span className={CLS.a}>温度 temperature（0–2）</span>
            <input
              className={CLS.f}
              type="number"
              min={0}
              max={2}
              step={0.1}
              defaultValue={ai.temperature ?? ''}
              placeholder="不发送"
              data-testid="ai-temperature"
              onBlur={(event) => save(numberPatch(event.target.value, 'temperature'))}
            />
          </label>
          <label className={CLS.e}>
            <span className={CLS.a}>top_p（0–1）</span>
            <input
              className={CLS.f}
              type="number"
              min={0}
              max={1}
              step={0.05}
              defaultValue={ai.topP ?? ''}
              placeholder="不发送"
              onBlur={(event) => save(numberPatch(event.target.value, 'topP'))}
            />
          </label>
          <label className={CLS.e}>
            <span className={CLS.a}>单次回复上限（tokens）</span>
            <input
              className={CLS.f}
              type="number"
              min={1}
              max={32000}
              step={256}
              defaultValue={ai.maxTokens ?? ''}
              placeholder="不发送"
              onBlur={(event) => save(numberPatch(event.target.value, 'maxTokens'))}
            />
          </label>
          <label className={CLS.e}>
            <span className={CLS.a}>JSON 模式</span>
            <select
              className={CLS.D}
              defaultValue={ai.jsonMode ?? 'auto'}
              data-testid="ai-json-mode"
              onChange={(event) => save({ jsonMode: event.target.value as AISettings['jsonMode'] })}
            >
              <option value="auto">自动（结构化场景才带）</option>
              <option value="on">强制开启</option>
              <option value="off">关闭（服务不认这个字段时选它）</option>
            </select>
          </label>
          <label className={CLS.e}>
            <span className={CLS.a}>超时（秒）</span>
            <input
              className={CLS.f}
              type="number"
              min={5}
              max={300}
              step={5}
              defaultValue={ai.timeoutSec ?? ''}
              placeholder="60"
              data-testid="ai-timeout"
              onBlur={(event) => save(numberPatch(event.target.value, 'timeoutSec'))}
            />
          </label>
        </div>
        <p className={CLS.c}>
          解析类场景（面经拆题 / 字段解析 / 简历诊断）固定用温度 0，这里的温度只影响话术与润色。
        </p>
      </details>

      <p className={CLS.c}>
        {local
          ? '本机端口：请求只到这台电脑，不出公网。'
          : ai.baseURL
            ? '⚠ 地址不在本机 —— 勾选发送的内容会明文经过网络离开这台电脑。'
            : '没填地址时不会发出任何请求。'}
      </p>
      <p className={CLS.c} data-testid="ai-usage">
        用量：成功 {usage.calls} 次 · 累计 {fmtTokens(usage.tokens)} tokens
        {usage.lastError ? ` · 最近失败：${usage.lastError}` : ''}
        （请求日志 {api.db.requestLog.length} 条，只记时间/地址/模型/字段指纹，无原文）
        {api.db.requestLog.length > 0 ? (
          <button type="button" className={CLS.k} onClick={api.ai.clearRequestLog}>
            清空
          </button>
        ) : null}
      </p>
      <p className={CLS.c}>API Key 明文保存，会随导出备份一起走。</p>
    </div>
  );
}
