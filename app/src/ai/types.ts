/**
 * AI 能力层类型（v0.8 / T03）。
 *
 * ★ 纪律：数据模型的 AISettings / AISuggestion / RequestLog 定义在 `src/types.ts`
 *   （迁移与校验都依赖那份定义），这里只 **re-export**，绝不写第二份 ——
 *   两份定义必然漂移，漂移的第一个受害者就是校验器。
 */

import type {
  AISettings,
  AISuggestion,
  AISuggestionMeta,
  AISuggestionStatus,
  AISuggestionTargetType,
  RequestLog,
  StagedReason,
} from '../types';

export type { AISettings, AISuggestion, AISuggestionStatus, AISuggestionTargetType, RequestLog };

/** TargetType 全集（枚举只增不改；为 v1.0 预留的值现在不出现） */
export const AI_TARGET_TYPES: readonly AISuggestionTargetType[] = [
  'question',
  'application_note',
  'staging_field',
  'resume_field',
];

/** OpenAI 兼容 chat/completions 的一条消息 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 生成参数（v0.10）。**所有字段都可缺省**：缺省 = 这个键根本不进请求体，
 * 由服务端用自己的默认值 —— 这比「猜一个 0.7」诚实得多。
 *
 * 两个来源，场景级优先：`settings.ai` 上的全局值 → `opts.params` 的场景覆盖。
 * 解析类场景（d14/d17/d19-diag）固定 temperature 0，见 `scenarios.scenarioParams`。
 */
export interface GenerationParams {
  /** 0–2 */
  temperature?: number;
  /** 0–1 */
  topP?: number;
  /** ≥1 的整数 */
  maxTokens?: number;
  /** JSON 模式（response_format）。服务端不支持时网关自动降级重试一次 */
  jsonMode?: boolean;
}

export interface CompletionOptions {
  messages: ChatMessage[];
  /** 缺省 true（SSE 流式）；显式 false 走一次性 JSON 响应 */
  stream?: boolean;
  /** 流式增量回调（只在 stream:true 时触发） */
  onDelta?: (delta: string) => void;
  /** 调用方取消。与 gateway 内部的双超时计时器共用同一个 AbortController */
  signal?: AbortSignal;
  /** v0.10：场景级参数覆盖（缺省跟随 settings.ai 的全局参数） */
  params?: GenerationParams;
}

/**
 * 用量（v0.10）。**只统计，不参与任何业务判断**。
 * 服务端不返回 usage 时为 undefined —— 面板显示「用量未知」而不是 0。
 */
export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

/**
 * 连通性自检结果（v0.10）。
 * ★ 只由用户点击「测试连接」触发 —— 绝不在启动/渲染时自动发生，
 *   「打开页面零请求」的承诺不因为有了探针而破例。
 */
export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  /** 探活成功时列出的模型 id（服务端不提供则为空数组，不当成失败） */
  models: string[];
  /** 成功时用的是哪条路：/models 还是最小 chat 探针 */
  via?: 'models' | 'chat';
  /** 失败时的中文原因（一句人话，可直接上屏） */
  error?: string;
  /** 失败时的错误码，供 UI 决定给什么动作 */
  code?: GatewayErrorCode;
}

/**
 * 错误码（v0.10 细分为 8 类）。
 * 之所以不用「http + status」让调用方自己判断：状态码到人话的映射是产品责任，
 * 散在 UI 里迟早各处写法不一。分类口径与给用户的话写在 `gateway.ERROR_HINT`。
 */
export type GatewayErrorCode =
  | 'timeout'
  | 'network'
  | 'http'
  | 'parse'
  | 'cancel'
  | 'auth'
  | 'not_found'
  | 'rate_limit';

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
  /** R-AI-11：question 建议的类别 / 我的回答（窄校验后的值才允许进来） */
  meta?: AISuggestionMeta;
}

/**
 * 接受建议的撤销快照（⌘Z 整体回退的最小信息集）。
 * 与 StatusUndo/SyncUndo 同构：只记「这次操作改了什么」，不复制整库。
 */
export interface AiUndoTarget {
  table: 'questions' | 'notes' | 'staging' | 'resumes' | 'experiences';
  id: string;
  /** 被改的字段名（新建行为空串） */
  field: string;
  /** 字段旧值；undefined = 原本没有这个字段（revert 时要删键而不是写 undefined） */
  prevValue: string | undefined;
  rowExisted: boolean;
  /** rowExisted=false 时的新建行原值（revert 时整行移除） */
  createdRow?: unknown;
  /**
   * 仅 staging 的 D17 写入：AI 补出公司名后会把暂存行的 reason 从 'unparsed'
   * 放开成 'unmapped'（否则它永远卡在「没解析出来」分支，用户没法归位）。
   * 撤销时要把原因原样放回去，否则「⌘Z 回退到操作前」只是半个真话。
   */
  prevReason?: StagedReason;
}

export interface AiUndo {
  /** 参与本次确认的建议原值（revert 时恢复 status='pending'） */
  suggestions: AISuggestion[];
  targets: AiUndoTarget[];
  /**
   * ★ R-AI-11：本次「全部采用」新建的 experience id。与 targets 分工（A-16）：
   * **删行走这里，字段回写走 targets**，两条通道不重叠 —— 删掉一整条面经
   * 连带它的题目一起消失，值得一个显式的名字，而不是混进「字段被改」的语义里。
   */
  createdExperiences?: string[];
}

/* ---------------------- 内置场景运行时（v0.8 / T05；v0.9 / T07 扩四个） ---------------------- */

/** 内置场景键；与 prompts.ts 的 AI_SCENARIOS 一一对应 */
export type AiScenarioKey =
  | 'd14'
  | 'd15'
  | 'd17'
  | 'd19-diag'
  | 'd19-polish'
  | 'd19-jd'
  | 'd20-analysis'
  | 'd14-bulk'; // ★ R-AI-11：与 d14 并列但独立，不动 d14 的输出契约（A-14）

/** 产出建议的场景（写 AISuggestion）；报告类场景（d19-diag / d20-analysis）不在此列 */
export const SUGGESTION_SCENARIOS: readonly AiScenarioKey[] = [
  'd14',
  'd15',
  'd17',
  'd19-polish',
  'd19-jd',
  'd14-bulk',
];

/** 报告类场景 → AIReport.targetType 的映射（写报告，不写建议） */
export const REPORT_SCENARIO_TYPES = {
  'd19-diag': 'resume_diagnosis',
  'd20-analysis': 'application_analysis',
} as const;

/**
 * 简历模块（T07 modulePicker 的数据形状，由 `ai/context.ts` 的 `resumeModules` 产出）。
 * ★ 结构性隐私：basics（姓名/电话/邮箱/城市/照片）根本不会成为模块 —— 联系方式
 *   不是「默认不勾」，是「没有勾选框」。
 */
export interface AiResumeModule {
  /** sectionId */
  id: string;
  /** 板块名（用户改过就用改的） */
  label: string;
  /** 板块纯文本（发送用；含字段名前缀，模型才能引用 fieldPath） */
  text: string;
  /** 润色主字段的全路径（s:sec:i:item:key）；板块没有可润色文本时为 null */
  primaryPath: string | null;
  /** 润色主字段的现值 */
  primaryText: string;
  /** fieldKey → 全路径（首个命中条目；JD 定向的 fieldPath 落点地图） */
  fieldPaths: Record<string, string>;
}

/**
 * 跑一次内置场景（D13 确认之后才调用）。
 * `checked` 就是用户在预览弹层里勾中的字段 —— 面板不自己拼请求体，
 * 否则「预览看到的」和「实际发出的」就有第二条通路（D13 铁律）。
 */
export interface AiRunInput {
  scenario: AiScenarioKey;
  checked: Record<string, string>;
  /** 建议落到哪一行：D14 = 面经 id（新建题用 resolveQuestionExperienceId）、D15 = 投递 id、D17 = 暂存行 id；d19 = 简历 id */
  targetId: string | null;
  /**
   * T07：模型的 fieldPath → 真实落点路径（s:sec:i:item:key）的映射。
   * 只由 modulePicker 的选中模块算出来，模型给不出的键映射不到 = 写回时自然落空。
   */
  context?: { fieldPaths: Record<string, string> };
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  /**
   * v0.10 / L3-3：重试时可强制走非流式。
   * 有的自建网关 SSE 会截断或多发空 delta，换非流式能排除这一层。
   */
  stream?: boolean;
}

/**
 * 场景结果。**失败一律返回原因字符串，不抛异常**（R-AI-5：
 * 断网 / 模型胡说八道都只该换来一句内联人话，不该是错误弹窗）。
 * 成功两分支：建议类 = 入库条数；报告类 = 报告 id（卡片区负责展示）。
 */
/** R-AI-11：AI 对头部信息的建议 —— 只做 chip 提示，不覆盖用户已填；日期永远不会来自 AI */
export interface BulkHeadSuggestion {
  companyName?: string;
  jobTitle?: string;
  round?: number | null;
}

/**
 * 一次成功的调用留下了什么（v0.10 / L3-4）。
 * 面板用它显示「1.2k tokens · 3.4s · qwen2.5:7b」；日志用它记账。
 * 服务端没给 usage 就没有 tokens —— 显示「用量未知」，不显示 0。
 */
export interface RunMeta {
  durationMs: number;
  model: string;
  tokens?: TokenUsage;
  /** 推理模型是否输出了思考过程（面板据此提一句「该模型会先思考」） */
  reasoning?: boolean;
}

export type AiRunOutcome =
  | {
      ok: true;
      kind: 'suggestions';
      created: number;
      /** 仅 d14-bulk：头部建议 / 未识别段落 / 被省略条数。其余场景不写（Q11 裁决） */
      head?: BulkHeadSuggestion;
      unmatched?: string[];
      truncated?: number;
      /** v0.10：用量与耗时（可选，旧调用点不必改） */
      meta?: RunMeta;
    }
  | { ok: true; kind: 'report'; reportId: string; meta?: RunMeta }
  | { ok: false; error: string };

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
