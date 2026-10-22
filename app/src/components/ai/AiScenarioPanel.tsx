/**
 * AI 场景面板（v0.8 / T05；v0.9 / T07 扩到七场景）—— 「预览 → 流式 → 建议/报告 → 确认」主干。
 *
 * 七个场景的差异只有「出境字段值从哪来」和「产出落到哪」，所以差异被压成
 * 一份 `scenarioConfig`（标题 / 说明 / 上下文值 / 是否需要粘贴 / 必发原文），
 * 主干只有这一份实现：
 *
 *   ① 用户在面板里准备好输入（D14/D19-jd 需要粘贴；d19 系列还要勾简历模块）
 *   ② 「预览」→ SendPreviewDialog（强制弹层，勾选什么就发什么）
 *   ③ 确认 → api.ai.runScenario（App 侧 gateway + RequestLog + 建议/报告入库）
 *   ④ 建议出现在 SuggestionList 逐条勾选；报告类走 onReport 回调（卡片区展示）
 *
 * 为什么不做七个包装组件：抄七份就会有一份忘了走预览，且每份都要重新声明一遍
 * 「发什么 / 写在哪」—— 体积和风险都是净浪费。调用方只给 scenario + targetId
 * （+ d19 系列的 `modules` 模块列表）。
 *
 * 未配置 / 断网：入口由调用方置灰，这里再兜一层内联说明 —— 不弹错误框（R-AI-5）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppApi } from '../../lib/api';
import type { AiResumeModule, AiScenarioKey, PreviewField } from '../../ai/types';
import { scenarioPluginId, scenarioPreviewFields } from '../../ai/scenarios';
import { buildApplicationContext, modulesText } from '../../ai/context';
import { clampText } from '../../lib/budget';
import { SendPreviewDialog } from './SendPreviewDialog';
import { SuggestionList } from './SuggestionList';

/** D14 粘贴上限：面经正文上限 3000 字，整段贴进来也要放得下 */
const PASTE_LIMIT = 5000;
/** 模块选择上限（PRD §10.1：1–3 个模块、合计 ≤4000 字） */
const MODULE_MAX = 3;
const MODULE_CHARS_TOTAL = 4000;

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

/** 七个场景的全部差异集中在这一处：谁的数据、发什么、落到哪一行 */
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
    const context = app ? buildApplicationContext(api.db, app) : null;
    return {
      title: '🤖 生成沟通话术',
      hint: '默认只发公司名、岗位、状态；轮次 / 面试类型 / 面试官 / 沟通记录在预览里单独勾选。',
      values: context
        ? {
            companyName: context.companyName,
            jobTitle: context.jobTitle,
            status: context.status,
            round: context.round,
            interviewKind: context.interviewKind,
            interviewer: context.interviewer,
            lastNote: context.lastNote,
          }
        : {},
      locked: {},
    };
  }
  if (scenario === 'd17') {
    const item = api.db.staging.find((entry) => entry.id === targetId);
    return {
      title: '🤖 用 AI 重试解析',
      hint: '只把这段原文发给模型（不含库内数据）。它给出的字段会附上依据的原文，勾选后才写回暂存行；归到哪个阶段仍由你决定。',
      values: {},
      // unparsed 行原文在 rawSnippet；落库往返过的历史数据可能只在 parsed.rawSnippet
      locked: { rawSnippet: item?.rawSnippet ?? item?.parsed.rawSnippet ?? '' },
    };
  }
  if (scenario === 'd19-polish') {
    return {
      title: '🤖 润色选中段落',
      hint: '勾一个板块，AI 把它的主字段改写成「动词开头、带数字」的简历句；原句与建议句并排，采用才写回草稿。',
      values: {},
      locked: {},
    };
  }
  if (scenario === 'd19-diag') {
    return {
      title: '🤖 简历诊断',
      hint: '勾 1–3 个模块并填目标岗位，AI 出一份诊断报告（只读，不改简历）。联系方式结构上不会被发送。',
      values: {},
      input: { field: 'targetJobTitle', label: '目标岗位名', placeholder: '例：前端开发实习生', limit: 100 },
      locked: {},
    };
  }
  if (scenario === 'd19-jd') {
    return {
      title: '🤖 按 JD 定向改写',
      hint: '粘贴 JD + 勾 1–3 个模块，AI 给出逐字段改写建议；采用一条写一条，不会自动建版本。',
      values: {},
      input: { field: 'jdText', label: '岗位 JD', placeholder: '粘贴这份岗位的 JD 原文（≤8000 字）', limit: 8000 },
      locked: {},
    };
  }
  const app = api.db.applications.find((item) => item.id === targetId);
  const context = app ? buildApplicationContext(api.db, app) : null;
  return {
    title: '🤖 分析这份投递的竞争力',
    hint: '默认只发 JD 原文、公司、岗位、状态；库内简历模块默认不勾（勾了才发）。',
    values: context ? { ...context, jdText: app?.jdText ?? '' } : { jdText: '' },
    locked: {},
  };
}

/** 场景的模块选择形态：润色单选（写回目标只有一个），诊断/定向多选，其余无 */
function modulePickOf(scenario: AiScenarioKey): 'one' | 'multi' | null {
  if (scenario === 'd19-polish') return 'one';
  if (scenario === 'd19-diag' || scenario === 'd19-jd') return 'multi';
  return null;
}

export interface AiScenarioPanelProps {
  api: AppApi;
  scenario: AiScenarioKey;
  /** 建议落点：D14 = 面经 id、D15/D20 = 投递 id、D17 = 暂存行 id、d19 系列 = 简历 id */
  targetId: string;
  onClose: () => void;
  /** T07：简历模块列表（ResumeEditor 传入）。缺省 = 这个场景不提供模块选择 */
  modules?: AiResumeModule[];
  /** T07：报告产出回调（d19-diag / d20-analysis）。拿到报告 id 后由调用方展示报告卡 */
  onReport?: (reportId: string) => void;
}

export function AiScenarioPanel({ api, scenario, targetId, onClose, modules, onReport }: AiScenarioPanelProps): JSX.Element {
  const { title, hint, values, input, locked } = scenarioConfig(api, scenario, targetId);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<PreviewField[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
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
  const modulePick = modulePickOf(scenario);
  const showModules = modulePick !== null && modules !== undefined && modules.length > 0;
  const pickedModules = showModules ? modules.filter((module) => picked.includes(module.id)) : [];
  const pickedChars = pickedModules.reduce((sum, module) => sum + module.text.length, 0);

  /** 模块选择的阻塞原因（null = 可以生成）。放在面板上而不是预览里：这是输入问题，不是发送问题 */
  const moduleHint: string | null = !showModules
    ? null
    : modulePick === 'one'
      ? pickedModules.length === 0
        ? '先勾一个板块'
        : pickedModules[0].primaryPath
          ? null
          : '这个板块没有可润色的文本'
      : pickedModules.length === 0
        ? '先勾 1–3 个板块'
        : pickedChars > MODULE_CHARS_TOTAL
          ? '选中模块合计超 4000 字 —— 先减一个板块'
          : null;

  const toggleModule = (id: string): void => {
    setPicked((prev) => {
      if (prev.includes(id)) return prev.filter((item) => item !== id);
      if (modulePick === 'one') return [id];
      if (prev.length >= MODULE_MAX) return prev; // 第 4 个勾不上，提示由 moduleHint 兜底说明上限
      return [...prev, id];
    });
  };

  /** 模型 fieldPath → 真实落点路径（s:sec:i:item:key）。只由选中模块算，模型给不出的键映射不到 */
  const fieldPathsFor = (): Record<string, string> => {
    if (!showModules) return {};
    if (modulePick === 'one') {
      const primary = pickedModules[0]?.primaryPath;
      return primary ? { polished: primary } : {};
    }
    const map: Record<string, string> = {};
    for (const module of pickedModules) Object.assign(map, module.fieldPaths);
    return map;
  };

  const openPreview = (): void => {
    const base: Record<string, string> = { ...values, ...locked };
    if (input) base[input.field] = text.trim();
    if (modulePick === 'one' && pickedModules[0]) {
      base.selectedText = pickedModules[0].primaryText;
      base.sectionLabel = pickedModules[0].label;
    } else if (modulePick === 'multi') {
      base.selectedModules = modulesText(pickedModules);
    }
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
    const fieldPaths = fieldPathsFor();
    const outcome = await api.ai.runScenario({
      scenario,
      targetId,
      checked,
      signal: controller.signal,
      ...(Object.keys(fieldPaths).length > 0 ? { context: { fieldPaths } } : {}),
    });
    abortRef.current = null;
    setRunning(false);
    if (!outcome.ok) setError(outcome.error);
    else if (outcome.kind === 'report') {
      onReport?.(outcome.reportId);
      onClose();
    }
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

          {showModules ? (
            <div className="ai-modules" role="group" aria-label="选择简历模块">
              <span className="field__label">{modulePick === 'one' ? '选择一个板块' : `选择 1–${MODULE_MAX} 个板块`}</span>
              <div className="ai-modules__list">
                {modules.map((module) => (
                  <label key={module.id} className="ai-modules__item">
                    <input
                      type="checkbox"
                      checked={picked.includes(module.id)}
                      onChange={() => toggleModule(module.id)}
                    />
                    <span>{module.label}</span>
                  </label>
                ))}
              </div>
              {moduleHint ? <p className="field__hint">{moduleHint}</p> : null}
            </div>
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
              evidence={scenario === 'd17' || scenario === 'd19-jd'}
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
              disabled={blocked !== null || emptyInput || moduleHint !== null}
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
