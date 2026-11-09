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
import type { AISuggestion, AiResumeModule, AiScenarioKey, PreviewField, RunMeta } from '../../ai/types';
import { buildScenarioMessages, scenarioPluginId, scenarioPreviewFields } from '../../ai/scenarios';
import { parseResumeFieldPath } from '../../ai/suggestions';
import { CONTEXT_WARN_TOKENS, estimateMessagesTokens, isContextHeavy } from '../../ai/budget';
import { REPORT_SCENARIO_TYPES } from '../../ai/types';
import { buildApplicationContext, modulesText } from '../../ai/context';
import { clampText } from '../../lib/budget';
import { SendPreviewDialog } from './SendPreviewDialog';
import { SuggestionList } from './SuggestionList';
import { REPORTS_PER_TARGET, reportQuotaOf, reportsOfTarget } from '../../ai/reports';
import { fmtDateTime } from '../../lib/date';
import { CLS } from '../../lib/classTokens';

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
    hint: '勾 1–3 个简历模块，AI 才会拿「你的经历」对照这份 JD；不勾就只分析岗位本身（维度一律 not_found）。库内模块默认不勾。',
    values: context ? { ...context, jdText: app?.jdText ?? '' } : { jdText: '' },
    locked: {},
  };
}

/**
 * 场景的模块选择形态：润色单选（写回目标只有一个），诊断 / 定向 / 投递分析多选，其余无。
 * ★ v0.10 / L2-1：d20-analysis 必须有模块选择 —— 没有它，「竞争力分析」只是在分析 JD，
 *   模型不知道候选人是谁，`evidenceFromResume` 只能靠编。
 */
function modulePickOf(scenario: AiScenarioKey): 'one' | 'multi' | null {
  if (scenario === 'd19-polish') return 'one';
  if (scenario === 'd19-diag' || scenario === 'd19-jd' || scenario === 'd20-analysis') return 'multi';
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
  /** v0.10 / L3-3：失败时「去检查配置」的出口（App 打开设置抽屉） */
  onOpenSettings?: () => void;
}

/** 生成阶段（L3-2）。sending 与 streaming 分开：用户能看出「卡在连接」还是「模型在写」 */
type Stage = 'idle' | 'sending' | 'streaming';

/** 用量一行的文案（L3-4）：没有 usage 就说「用量未知」，不写 0 */
function fmtMeta(meta: RunMeta): string {
  const parts: string[] = [];
  if (meta.tokens) parts.push(`${meta.tokens.total} tokens`);
  parts.push(`${(meta.durationMs / 1000).toFixed(1)}s`);
  parts.push(meta.model);
  if (meta.reasoning) parts.push('推理模型（会先思考）');
  return parts.join(' · ');
}

export function AiScenarioPanel({ api, scenario, targetId, onClose, modules, onReport, onOpenSettings }: AiScenarioPanelProps): JSX.Element {
  const { title, hint, values, input, locked } = scenarioConfig(api, scenario, targetId);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<PreviewField[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  /** v0.10 / L3-2：阶段与已生成字数（让「卡住了」和「在写」可区分） */
  const [stage, setStage] = useState<Stage>('idle');
  const [chars, setChars] = useState(0);
  /** v0.10 / L3-4：上一次调用的用量 */
  const [meta, setMeta] = useState<RunMeta | null>(null);
  /** 失败后重试要复用同一份勾选（否则用户得重新勾一遍） */
  const [lastChecked, setLastChecked] = useState<Record<string, string> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** 同步防重入（setRunning 是异步的，连点两下仍会进两次） */
  const inFlight = useRef(false);

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

  /**
   * 报告类场景的配额告知（v0.9.1 / R-AI-10，架构 B-10）。
   *
   * 报告有两道上限：同一目标只留 3 份、全库 200 份。v0.9 里这两道闸都是**静默**的 ——
   * 用户连点第四次诊断，最早那份就没了，界面上什么都没发生。这里改成发送**之前**
   * 就说清楚「会顶掉哪一份」，并给出「先删最早一份」的显式入口（Q3：告知 + 用户显式删，
   * 而不是替他删得更多）。
   *
   * 只对报告场景生效：建议类场景不落报告表，不占这个配额。
   */
  const isReportScene = scenario === 'd19-diag' || scenario === 'd20-analysis';
  const reportRows = api.db.aiReports ?? [];
  const quota = reportQuotaOf(reportRows);
  const targetReports = isReportScene
    ? reportsOfTarget(
        reportRows,
        REPORT_SCENARIO_TYPES[scenario as 'd19-diag' | 'd20-analysis'],
        targetId,
      )
    : [];
  /** 这一份生成后会被顶掉的那份（null = 不会顶掉任何东西） */
  const evicted = targetReports.length >= REPORTS_PER_TARGET ? targetReports[targetReports.length - 1] : null;
  const quotaFull = isReportScene && quota.full;

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

  /** 模型 fieldPath → 真实落点路径（s:sec:i:item:key）。只由选中模块算，模型给不出的键映射不到 */  const fieldPathsFor = (): Record<string, string> => {
    if (!showModules) return {};
    if (modulePick === 'one') {
      const primary = pickedModules[0]?.primaryPath;
      return primary ? { polished: primary } : {};
    }
    const map: Record<string, string> = {};
    for (const module of pickedModules) Object.assign(map, module.fieldPaths);
    return map;
  };

  /**
   * 本次预计要发多少 token（v0.10 / L1-9）。
   * 口径与 openPreview 完全一致：上下文值 + 输入框 / 选中模块 —— 否则估的就不是「要发的东西」。
   */
  const estimatedTokens = ((): number => {
    const base: Record<string, string> = { ...values, ...locked };
    if (input) base[input.field] = text.trim();
    if (modulePick === 'one' && pickedModules[0]) base.selectedText = pickedModules[0].primaryText;
    else if (modulePick === 'multi') base.selectedModules = modulesText(pickedModules);
    return estimateMessagesTokens(buildScenarioMessages(scenario, base));
  })();

  /**
   * v0.10 / L3-6：这条建议会替换哪段原文。
   * 只有能**确定**落点时才返回（简历字段路径可解析 / 暂存行有该键）；
   * 拿不准就返回 undefined —— 宁可少一个 diff，也不要并排显示一段错的原值。
   */
  const originalOf = (suggestion: AISuggestion): string | undefined => {
    if (suggestion.targetType === 'resume_field') {
      const resume = api.db.resumes.find((item) => item.id === suggestion.targetId);
      if (!resume) return undefined;
      const path = parseResumeFieldPath(suggestion.fieldPath);
      if (!path) return undefined;
      const section = resume.content.sections.find((item) => item.id === path.sectionId);
      const row = section?.items.find((item) => item.id === path.itemId);
      if (!row) return undefined;
      // 要点类字段的原文存在 bullets 里（fields 里是空串）
      if (path.key === 'description' || path.key === 'customText' || path.key === 'skillsText') {
        return (row.bullets ?? []).join('\n');
      }
      return row.fields[path.key];
    }
    if (suggestion.targetType === 'staging_field') {
      const row = api.db.staging.find((item) => item.id === suggestion.targetId);
      if (!row) return undefined;
      const value = (row.parsed as unknown as Record<string, unknown>)[suggestion.fieldPath];
      return typeof value === 'string' ? value : undefined;
    }
    return undefined;
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

  const run = async (checked: Record<string, string>, stream = true): Promise<void> => {
    // L1-10 防重复提交：连点两下不该发两次（一次调用 = 一次计费）
    if (inFlight.current) return;
    inFlight.current = true;
    setPreview(null);
    setRunning(true);
    setError(null);
    setMeta(null);
    setChars(0);
    setStage('sending');
    setLastChecked(checked);
    const controller = new AbortController();
    abortRef.current = controller;
    const fieldPaths = fieldPathsFor();
    try {
      const outcome = await api.ai.runScenario({
        scenario,
        targetId,
        checked,
        stream,
        signal: controller.signal,
        // 结构化输出不把原始 JSON 刷给用户，但这个回调能证明「模型确实在动」
        onDelta: (delta) => {
          setStage('streaming');
          setChars((count) => count + delta.length);
        },
        ...(Object.keys(fieldPaths).length > 0 ? { context: { fieldPaths } } : {}),
      });
      if (!outcome.ok) {
        setError(outcome.error);
        setStage('idle');
        return;
      }
      if (outcome.meta) setMeta(outcome.meta);
      setStage('idle');
      if (outcome.kind === 'report') {
        onReport?.(outcome.reportId);
        onClose();
      }
    } catch (thrown) {
      // runScenario 按约定只回错误字符串；真抛出来说明是 bug，也要变成一句人话
      setError(thrown instanceof Error ? `生成失败：${thrown.message}` : '生成失败');
      setStage('idle');
    } finally {
      abortRef.current = null;
      inFlight.current = false;
      setRunning(false);
    }
  };

  /** 失败后的三种救法（L3-3）：正常重试 / 换非流式 / 去检查配置 */
  const retry = (stream: boolean): void => {
    if (lastChecked) void run(lastChecked, stream);
  };

  return (
    <div
      className={CLS.U}
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
        <header className={CLS.ac}>
          <h2 className={CLS.Y}>{title}</h2>
          <button type="button" className={CLS.m} onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className={CLS.aa}>
          <p className={CLS.c}>{hint}</p>

          {blocked ? (
            <p className={CLS.s} data-testid="ai-blocked">
              {blocked} —— 配好之前这个入口不会发出任何请求。
            </p>
          ) : null}

          {showModules ? (
            <div className="ai-modules" role="group" aria-label="选择简历模块">
              <span className={CLS.a}>{modulePick === 'one' ? '选择一个板块' : `选择 1–${MODULE_MAX} 个板块`}</span>
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
              {moduleHint ? <p className={CLS.c}>{moduleHint}</p> : null}
            </div>
          ) : null}

          {input ? (
            <label className={CLS.g}>
              <span className={CLS.a}>
                {input.label}（≤{input.limit} 字）
              </span>
              <textarea
                className={CLS.T}
                rows={6}
                value={text}
                placeholder={input.placeholder}
                data-testid="ai-input"
                onChange={(event) => setText(clampText(event.target.value, input.limit).text)}
              />
            </label>
          ) : null}

          {/* v0.10 / L1-9：发送前就知道大概多少 token；超预警线只说一句，不阻断 */}
          <p className={isContextHeavy(estimatedTokens) ? CLS.s : CLS.c} data-testid="ai-tokens">
            本次约 {estimatedTokens} tokens
            {isContextHeavy(estimatedTokens)
              ? ` —— 超过 ${CONTEXT_WARN_TOKENS} 预警线，可能超出模型上下文，建议少选一个模块`
              : '（估算，用于心里有数）'}
          </p>

          {running ? (
            <p className={CLS.c} data-testid="ai-running" aria-live="polite">
              {stage === 'sending' ? '正在连接模型…' : `模型已生成 ${chars} 字，正在整理成建议…`}
              （可以点「停止」）
            </p>
          ) : null}

          {error ? (
            <div className="ai-error" data-testid="ai-error" aria-live="assertive">
              <p className={CLS.s}>{error}</p>
              <div className={CLS.r}>
                <button type="button" className={CLS.b} data-testid="ai-retry" onClick={() => retry(true)}>
                  重试
                </button>
                <button type="button" className={CLS.b} onClick={() => retry(false)}>
                  改用非流式重试
                </button>
                {onOpenSettings ? (
                  <button type="button" className={CLS.k} onClick={onOpenSettings}>
                    去检查配置
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {meta ? (
            <p className={CLS.c} data-testid="ai-meta" aria-live="polite">
              本次：{fmtMeta(meta)}
            </p>
          ) : null}

          {pending.length > 0 ? (
            <SuggestionList
              suggestions={pending}
              evidence={scenario === 'd17' || scenario === 'd19-jd'}
              originalOf={originalOf}
              onAccept={(ids) => {
                api.ai.acceptSuggestions(ids);
                onClose();
              }}
              onReject={(ids) => api.ai.rejectSuggestions(ids)}
              emptyText="还没有 AI 建议"
            />
          ) : null}
        </div>

        {isReportScene && (quota.full || evicted) ? (
          <div className="report-quota-hint" data-testid="ai-quota-hint">
            <span className={CLS.c}>
              {quota.full
                ? `全库报告已满（${quota.used}/${quota.limit} 份）—— 这里暂时不能生成，先在报告历史里删几份旧的。`
                : `这个目标已有 ${targetReports.length} 份报告，新生成的这份会让最早的一份（${fmtDateTime(
                    evicted?.createdAt ?? '',
                  )}）被顶掉。`}
            </span>
            {evicted ? (
              <button type="button" className={CLS.h} onClick={() => api.deleteReport(evicted.id)}>
                先删最早一份
              </button>
            ) : null}
          </div>
        ) : null}

        <footer className={CLS.ab}>
          <span className={CLS.c}>下一步的预览里勾了什么，就只发什么</span>
          <button type="button" className={CLS.Q} onClick={onClose}>
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
              className={CLS.j}
              data-testid="ai-generate"
              disabled={blocked !== null || emptyInput || moduleHint !== null || quotaFull}
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
