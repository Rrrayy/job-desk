/**
 * AI 服务设置（v0.8 / T05）：设置抽屉里的「AI 服务（可选）」一段。
 *
 * 设计取舍：
 * - **不预填任何地址**。缺省 = 未配置，三个场景入口诚实置灰 ——
 *   预填一个「看起来能用」的地址，只会在第一次发送时换来一句连接失败。
 * - 预设（Ollama / LM Studio）只填地址，不猜模型名（每台机器装的模型不一样）。
 * - key 明文存储（R-AI-4 为 P1），所以把风险直说，而不是藏在 placeholder 里。
 * - `isLocal` 由地址推导（127.0.0.1 / localhost / ::1），预览据此明示「不出公网」。
 */

import { useState } from 'react';
import type { AppApi } from '../../lib/api';
import type { AISettings } from '../../types';
import { isLocalBaseUrl } from '../../ai/settings';

/** 一键预设：只填地址，模型名留给用户 */
const PRESETS: Array<{ label: string; baseURL: string }> = [
  { label: 'Ollama 本地', baseURL: 'http://127.0.0.1:11434/v1' },
  { label: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1' },
];

const EMPTY: AISettings = { baseURL: '', model: '', isLocal: false };

export function AiSettingsPanel({ api }: { api: AppApi }): JSX.Element {
  const ai = api.db.settings.ai ?? EMPTY;
  /** 本地回显：刚点预设时输入框要立刻显示新地址（受控 + 提交进 settings） */
  const [baseURL, setBaseURL] = useState(ai.baseURL);
  const [model, setModel] = useState(ai.model);

  const save = (patch: Partial<AISettings>): void => {
    const next: AISettings = { ...ai, ...patch };
    next.isLocal = isLocalBaseUrl(next.baseURL);
    if (!next.apiKey) delete next.apiKey;
    api.updateSettings({ ai: next });
  };

  const applyPreset = (value: string): void => {
    setBaseURL(value);
    save({ baseURL: value });
  };

  const local = isLocalBaseUrl(ai.baseURL);

  return (
    <div data-testid="ai-settings">
      <p className={api.ai.ready ? 'field__hint' : 'field__hint field__hint--danger'}>
        {api.ai.ready
          ? '已配置：三个场景可用，每次发送前强制预览。'
          : `${api.ai.readyReason ?? 'AI 未配置'}。未配置时入口是灰的，不会弹错误框。`}
      </p>

      <div className="drawer__grid">
        <label className="field">
          <span className="field__label">服务地址（含 /v1）</span>
          <input
            className="input"
            value={baseURL}
            placeholder="http://127.0.0.1:11434/v1"
            data-testid="ai-base-url"
            onChange={(event) => setBaseURL(event.target.value)}
            onBlur={() => save({ baseURL: baseURL.trim() })}
          />
        </label>
        <label className="field field--narrow">
          <span className="field__label">模型名</span>
          <input
            className="input"
            value={model}
            placeholder="qwen2.5:7b"
            data-testid="ai-model"
            onChange={(event) => setModel(event.target.value)}
            onBlur={() => save({ model: model.trim() })}
          />
        </label>
        <label className="field field--narrow">
          <span className="field__label">API Key（本地可空）</span>
          <input
            className="input"
            type="password"
            defaultValue={ai.apiKey ?? ''}
            autoComplete="off"
            placeholder="留空 = 不带 Authorization"
            onBlur={(event) => save({ apiKey: event.target.value.trim() })}
          />
        </label>
      </div>

      <div className="btn-row">
        {PRESETS.map((preset) => (
          <button key={preset.baseURL} type="button" className="btn btn--small" onClick={() => applyPreset(preset.baseURL)}>
            {preset.label}
          </button>
        ))}
      </div>

      <p className="field__hint">
        {local
          ? '本机端口：请求只到这台电脑，不出公网。'
          : ai.baseURL
            ? '⚠ 地址不在本机 —— 勾选发送的内容会明文经过网络离开这台电脑。'
            : '没填地址时不会发出任何请求。'}
      </p>
      <p className="field__hint">
        API Key 明文保存，会随导出备份一起走。请求日志 {api.db.requestLog.length} 条
        （时间 / 地址 / 模型 / 字段指纹，无原文）。
        {api.db.requestLog.length > 0 ? (
          <button type="button" className="link-btn" onClick={api.ai.clearRequestLog}>
            清空
          </button>
        ) : null}
      </p>
    </div>
  );
}
