/**
 * 内置 AI 场景的字段声明与提示词（v0.8 / T03）。
 *
 * ★ prompts 压缩为紧凑模板：system 提示每场景 ≤10 行，这是体积预算（3 KB
 *   整个 AI 核心库）里最容易爆的一块。场景 UI 本体在 T05（D14/D15/D17），
 *   这里 T03 先把「出境字段白名单」立起来 —— SendPreviewDialog 的默认勾选
 *   基线（PRD 验收 8）就是按这些 fields 断言的。
 *
 * 字段名与 Application/StagedSyncItem 的键对齐，D13 预览按 name 分组：
 * companyName/jobTitle/status 默认勾选；round/interviewKind/writtenResult/
 * 面经原文等新增出境字段默认**不**勾选。
 */

import type { AISuggestionTargetType } from '../types';
import type { AiScenarioKey, PreviewField } from './types';

export interface AiScenarioSpec {
  /** 内置场景固定前缀 builtin:（与插件 pluginId 同一命名空间） */
  pluginId: string;
  targetType: AISuggestionTargetType;
  /** ≤10 行的紧凑 system 提示 */
  system: string;
  /** 出境字段声明（locked = 必发，其余默认不勾） */
  fields: PreviewField[];
}

const D14_SYSTEM = [
  '你是面试复盘助手。输入是一段面经笔记。',
  '任务：从中提取「面试官问了什么」，每题输出一行，格式：题目 | 类别(algo/concept/project/behavior/reverse/hr)。',
  '规则：只输出笔记里真实出现的题，不编造；题干保持原意可轻度精简；不输出答案。',
  '输出必须是 JSON：{"questions":[{"text":"...","category":"algo"}]}，除此之外不要任何文字。',
].join('\n');

const D15_SYSTEM = [
  '你是求职沟通助手。输入是岗位上下文与最近沟通记录。',
  '任务：起草一条发给 HR/面试官的中文消息（跟进进度 / 约时间 / 感谢）。',
  '规则：120 字以内、口语化、不谄媚；不编造事实（没提到的经历不要写）。',
  '输出必须是 JSON：{"draft":"..."}，除此之外不要任何文字。',
].join('\n');

const D17_SYSTEM = [
  '你是表格解析助手。输入是招聘平台页面的原始文本片段（正则解析失败的兜底）。',
  '任务：从中识别一条求职记录的公司名/岗位名/状态/城市/薪资。',
  '规则：只输出片段里明确出现的值，认不出就省略该字段；状态映射到：想投/已投/沟通中/笔试/已约面/面试中/offer/已入职/已拒绝/已放弃。',
  '输出必须是 JSON：{"fields":[{"field":"companyName","value":"...","evidence":"原文片段"}]}，不要任何其他文字。',
].join('\n');

export const AI_SCENARIOS: Record<AiScenarioKey, AiScenarioSpec> = {
  d14: {
    pluginId: 'builtin:d14',
    targetType: 'question',
    system: D14_SYSTEM,
    fields: [
      // 默认出境 = 粘贴文本，**仅此一项**（PRD R-AI-1）。用户粘贴 = 已授权，故 locked。
      // 公司名/岗位是可选上下文：默认不勾（显式 defaultChecked:false 覆盖全局基线）。
      { name: 'note', label: '面经笔记原文', value: '', locked: true },
      { name: 'companyName', label: '公司名', value: '', defaultChecked: false },
      { name: 'jobTitle', label: '岗位名', value: '', defaultChecked: false },
    ],
  },
  d15: {
    pluginId: 'builtin:d15',
    targetType: 'application_note',
    system: D15_SYSTEM,
    fields: [
      // 默认出境 = 公司名 + 岗位 + 状态（PRD Q8 定案，恰好等于全局基线）
      { name: 'companyName', label: '公司名', value: '' },
      { name: 'jobTitle', label: '岗位名', value: '' },
      { name: 'status', label: '当前状态', value: '' },
      // 以下为显式追加项，默认不勾（轮次 / 面试类型 / 面试官称呼 / 沟通记录）
      { name: 'round', label: '当前轮次', value: '' },
      { name: 'interviewKind', label: '面试类型', value: '' },
      { name: 'interviewer', label: '面试官称呼', value: '' },
      { name: 'lastNote', label: '最近沟通记录', value: '' },
    ],
  },
  d17: {
    pluginId: 'builtin:d17',
    targetType: 'staging_field',
    system: D17_SYSTEM,
    fields: [
      // 铁律：只发用户粘贴的原文（locked）。其余「已识别部分」即使有用也默认不勾 ——
      // AI 解析的输入必须与库内数据隔离，否则「只发原文」就成了空话（验收 11）。
      { name: 'rawSnippet', label: '用户粘贴的原文片段', value: '', locked: true },
      { name: 'companyName', label: '公司名（已识别部分）', value: '', defaultChecked: false },
      { name: 'jobTitle', label: '岗位名（已识别部分）', value: '', defaultChecked: false },
      { name: 'status', label: '状态（已识别部分）', value: '', defaultChecked: false },
    ],
  },
};

/** 场景 spec → D13 预览字段（value 由调用方按上下文填充） */
export function previewFieldsOf(
  spec: AiScenarioSpec,
  values: Record<string, string>,
): PreviewField[] {
  return spec.fields.map((field) => ({ ...field, value: values[field.name] ?? '' }));
}
