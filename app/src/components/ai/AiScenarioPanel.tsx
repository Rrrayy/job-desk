/**
 * AI 场景面板（v0.8 / T05）—— D14 / D15 / D17 共用的「预览 → 流式 → 建议 → 确认」主干。
 *
 * 三个场景的差异只有「出境字段值从哪来」和「产出落到哪一行」，所以差异被压成
 * 一份 `scenarioConfig`（标题 / 说明 / 上下文值 / 是否需要粘贴 / 必发原文），
 * 主干只有这一份实现：
 *
 *   ① 用户在面板里准备好输入（仅 D14 需要粘贴原文）
 *   ② 「预览」→ SendPreviewDialog（强制弹层，勾选什么就发什么）
 *   ③ 确认 → api.ai.runScenario（App 侧 gateway + RequestLog + 建议入库）
 *   ④ 建议出现在 SuggestionList，逐条勾选 → api.ai.acceptSuggestions（单次 mutate + ⌘Z）
 *
 * 为什么不做三个包装组件：抄三份就会有一份忘了走预览，且每份都要重新声明一遍
 * 「发什么 / 写在哪」—— 体积和风险都是净浪费。调用方只给 scenario + targetId。
 *
 * 未配置 / 断网：入口由调用方置灰，这里再兜一层内联说明 —— 不弹错误框（R-AI-5）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppApi } from '../../lib/api';
import type { AiScenarioKey, PreviewField } from '../../ai/types';
import { scenarioPluginId, scenarioPreviewFields } from '../../ai/scenarios';
import { INTERVIEW_KIND_LABEL, STATUS_LABEL } from '../../lib/rules';
import { companyFullName } from '../../lib/util';
import { clampText } from '../../lib/budget';
import { SendPreviewDialog } from './SendPreviewDialog';
import { SuggestionList } from './SuggestionList';

/** D14 粘贴上限：面经正文上限 3000 字，整段贴进来也要放得下 */
const PASTE_LIMIT = 5000;

interface ScenarioInput {
  field: string;
  label: string;
  placeholder: string;
  limit: number;
}

interface ScenarioConfig {
  title: string;
  /** 面板顶部的一句说明：发什么、得到什么、写在哪 */
  hint: string;
  /** 场景上下文值（默认勾选口径由 prompts.ts 决定，这里只管值） */
  values: Record<string, string>;
  input?: ScenarioInput;
  /** 必发原文（D17），勾选框禁用 */
  locked: Record<string, string>;
}

/** 三个场景的全部差异集中在这一处：谁的数据、发什么、落到哪一行 */
function scenarioConfig(api: AppApi, scenario: AiScenarioKey, targetId: string): ScenarioConfig {
  if (scenario === 'd14') {
    const experience = api.db.experiences.find((item) => item.id === targetId);
    return {
      title: '🤖 用 AI 整理这段面经',
      hint: '粘贴这场面试的零散记录，AI 拆成一道道题。默认只发这段文字，题逐条勾选后才写进这场面经。',
      values: { companyName: experience?.companyName ?? '', jobTitle: experience?.jobTitle ?? '' },
      input: {
        field: 'note',
        label: '面经原文',
        placeholder: '例：一面 40 分钟，先问项目，然后问 Vue 响应式原理、手写防抖，最后反问…',
        limit: PASTE_LIMIT,
      },
      locked: {},
    };
  }
  if (scenario === 'd15') {
    const app = api.db.applications.find((item) => item.id === targetId);
    const interviews = app
      ? api.db.interviews
          .filter((item) => item.applicationId === app.id)
          .sort((a, b) => (a.scheduledAt < b.scheduledAt ? 1 : a.scheduledAt > b.scheduledAt ? -1 : 0))
      : [];
    const latest = interviews[0];
    const lastNote = app
      ? api.db.notes
          .filter((item) => item.applicationId === app.id)
          .sort((a, b) => (a.touchedAt < b.touchedAt ? 1 : a.touchedAt > b.touchedAt ? -1 : 0))[0]
      : undefined;
    return {
      title: '🤖 生成沟通话术',
      hint: '默认只发公司名、岗位、状态；轮次 / 面试类型 / 面试官 / 沟通记录在预览里单独勾选。',
      values: {
        companyName: app ? companyFullName(api.db.companies, app.companyId) : '',
        jobTitle: app?.jobTitle ?? '',
        status: app ? STATUS_LABEL[app.status] : '',
        round: latest ? `第 ${latest.round} 轮` : '',
        interviewKind: latest?.kind ? INTERVIEW_KIND_LABEL[latest.kind] : '',
        interviewer: latest?.interviewer ?? '',
        lastNote: (lastNote?.content ?? '').slice(0, 200),
      },
      locked: {},
    };
  }
  const item = api.db.staging.find((entry) => entry.id === targetId);
  return {
    title: '🤖 用 AI 重试解析',
    hint: '只把这段原文发给模型（不含库内数据）。它给出的字段会附上依据的原文，勾选后才写回暂存行；归到哪个阶段仍由你决定。',
    values: {},
    // unparsed 行原文在 rawSnippet；落库往返过的历史数据可能只在 parsed.rawSnippet
    locked: { rawSnippet: item?.rawSnippet ?? item?.parsed.rawSnippet ?? '' },
  };
}

export interface AiScenarioPanelProps {
  api: AppApi;
  scenario: AiScenarioKey;
  /** 建议落点：D14 = 面经 id、D15 = 投递 id、D17 = 暂存行 id */
  targetId: string;
  onClose: () => void;
}

export function AiScenarioPanel({ api, scenario, targetId, onClose }: AiScenarioPanelProps): JSX.Element {
  const { title, hint, values, input, locked } = scenarioConfig(api, scenario, targetId);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<PreviewField[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const pluginId = scenarioPluginId(scenario);
  /** 只显示「这一行、这个场景」还待确认的建议 —— 别的场景的建议不在这里冒出 */
  const pending = useMemo(
    () =>
      api.db.aiSuggestions.filter(
        (item) => item.pluginId === pluginId && item.targetId === targetId && item.status === 'pending',
      ),
    [api.db.aiSuggestions, pluginId, targetId],
  );

  // 关面板时把在飞的请求掐掉：用户已经走了，再收流式增量没有意义
  useEffect(() => () => abortRef.current?.abort(), []);

  const blocked = api.ai.ready ? null : api.ai.readyReason ?? 'AI 服务未配置';
  const ai = api.db.settings.ai;
  const emptyInput = input !== undefined && text.trim().length === 0;

  const openPreview = (): void => {
    const base: Record<string, string> = { ...values, ...locked };
    if (input) base[input.field] = text.trim();
    setError(null);
    setPreview(scenarioPreviewFields(scenario, base));
  };

  const run = async (checked: Record<string, string>): Promise<void> => {
    setPreview(null);
    setRunning(true);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    // 仍然是流式请求（首个 token 就到了，不用等全文），但面板只显示「生成中」：
    // 把原始 JSON 一字一字刷给用户既看不懂，又会把面板自己变成卡顿源。
    const outcome = await api.ai.runScenario({ scenario, targetId, checked, signal: controller.signal });
    abortRef.current = null;
    setRunning(false);
    if (!outcome.ok) setError(outcome.error);
  };

  return (
    <div
      className="overlay"
      onClick={(event) => {
        // 面板可能挂在别的浮层里（面经编辑器 / 同步抽屉）—— 冒泡上去会把它们一起关掉
        event.stopPropagation();
        onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="ai-scenario-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal__head">
          <h2 className="modal__title">{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="modal__body">
          <p className="field__hint">{hint}</p>

          {blocked ? (
            <p className="field__hint field__hint--danger" data-testid="ai-blocked">
              {blocked} —— 配好之前这个入口不会发出任何请求。
            </p>
          ) : null}

          {input ? (
            <label className="field">
              <span className="field__label">
                {input.label}（≤{input.limit} 字）
              </span>
              <textarea
                className="textarea"
                rows={6}
                value={text}
                placeholder={input.placeholder}
                data-testid="ai-input"
                onChange={(event) => setText(clampText(event.target.value, input.limit).text)}
              />
            </label>
          ) : null}

          {running ? (
            <p className="field__hint" data-testid="ai-running">
              模型正在生成…（最多等 60 秒，可以点「停止」）
            </p>
          ) : null}

          {error ? (
            <p className="field__hint field__hint--danger" data-testid="ai-error">
              {error}
            </p>
          ) : null}

          {pending.length > 0 ? (
            <SuggestionList
              suggestions={pending}
              evidence={scenario === 'd17'}
              onAccept={(ids) => {
                api.ai.acceptSuggestions(ids);
                onClose();
              }}
              onReject={(ids) => api.ai.rejectSuggestions(ids)}
              emptyText="还没有 AI 建议"
            />
          ) : null}
        </div>

        <footer className="modal__foot">
          <span className="field__hint">下一步的预览里勾了什么，就只发什么</span>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {running ? '关闭' : '取消'}
          </button>
          {running ? (
            <button
              type="button"
              className="btn btn--danger-ghost"
              data-testid="ai-stop"
              onClick={() => abortRef.current?.abort()}
            >
              停止
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              data-testid="ai-generate"
              disabled={blocked !== null || emptyInput}
              onClick={openPreview}
            >
              预览要发送的内容
            </button>
          )}
        </footer>

        {preview ? (
          <SendPreviewDialog
            title={title}
            pluginId={pluginId}
            baseURL={ai?.baseURL ?? ''}
            model={ai?.model ?? ''}
            isLocal={ai?.isLocal ?? false}
            fields={preview}
            onConfirm={(checked) => void run(checked)}
            onCancel={() => setPreview(null)}
          />
        ) : null}
      </div>
    </div>
  );
}
