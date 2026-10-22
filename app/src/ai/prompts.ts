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
  /** 建议类场景的写回通道；报告类场景（d19-diag/d20-analysis）不产出建议，缺省 */
  targetType?: AISuggestionTargetType;
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

/**
 * v0.9 四个场景共用的开场（PRD §10）：省的是每个 system 重复的边界声明。
 * 「联系方式不会出现在输入里」不是承诺，是 context.ts 的结构保证 —— 这里只是告诉模型别问。
 */
const T07_PREAMBLE = '你是简历与求职助手。输入只包含用户主动选择的内容；姓名、电话、邮箱、照片等联系方式不会出现，也不要索要。';

const D19_DIAG_SYSTEM = [
  T07_PREAMBLE,
  '你是简历诊断教练。输入是候选人的 1–3 个简历模块文本与目标岗位。',
  '任务：对照目标岗位逐维度判断匹配度，每个维度给出简历/JD 两边的证据原句。',
  'verdict 只能是 strong_match / partial_match / gap / not_found（材料没提到就用 not_found，不要猜）。',
  '输出必须是 JSON：{"summary":"两句话总评","next_steps":["最优先的一步"],"dimensions":[{"key":"k","label":"维度","verdict":"gap","evidenceFromResume":"简历原句","evidenceFromJd":"JD 原句","gapDescription":"差在哪"}]}，除此之外不要任何文字。',
].join('\n');

const D19_POLISH_SYSTEM = [
  T07_PREAMBLE,
  '你是简历润色助手。输入是一段简历原文与所在板块名。',
  '任务：改写成「动词开头、尽量带数字」的中文简历句。保持原有事实，绝不编造没写过的数字或经历。',
  '输出必须是 JSON：{"polished":"改写后的整段","reasons":["为什么这样改"]}，除此之外不要任何文字。',
].join('\n');

const D19_JD_SYSTEM = [
  T07_PREAMBLE,
  '你是简历定向改写助手。输入是一份 JD 与候选人的若干简历模块（每行以字段名开头，如 description: …）。',
  '任务：对照 JD 挑出值得改写的字段，产出改写建议。fieldPath 必须用输入里出现过的字段名。',
  '规则：只基于候选人已有经历改写，不编造新经历；每条建议附 JD 依据原句。',
  '输出必须是 JSON：{"suggestions":[{"fieldPath":"description","content":"改写后的内容","evidence":"JD 原句"}]}，不要任何其他文字。',
].join('\n');

const D20_SYSTEM = [
  T07_PREAMBLE,
  '你是求职竞争力分析师。输入是一条投递的 JD 原文与公司/岗位/状态。',
  '任务：逐维度判断候选人与岗位的匹配度，给出两句话总评与下一步建议。',
  'verdict 只能是 strong_match / partial_match / gap / not_found（材料没提到就用 not_found）。',
  '输出必须是 JSON：{"summary":"两句话总评","next_steps":["下一步"],"dimensions":[{"key":"k","label":"维度","verdict":"gap","evidenceFromResume":"依据原句","evidenceFromJd":"JD 原句"}]}，除此之外不要任何文字。',
].join('\n');

const D14_BULK_SYSTEM = [
  T07_PREAMBLE,
  '你是面经整理助手。输入是一整段面试记录。',
  '任务① questions：把记录拆成一道道题，每题给出题干与类别（algo/concept/project/behavior/reverse/hr 之一）；候选人当时的回答放 myAnswer，没有就省略。只拆真实出现的题，不编造。',
  '任务② unmatched：没识别成题目的原文段落原样保留，一段一项，绝不丢弃。',
  '任务③ head：记录里明确出现的公司名/岗位名/轮次；没有就不要给。',
  '输出必须是 JSON：{"head":{"companyName":"..."},"questions":[{"text":"...","category":"algo","myAnswer":"..."}],"unmatched":["..."]}，除此之外不要任何文字。',
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
  /* ---------------- v0.9 / T07 四场景（出境表 = PRD §10，字段表就是白名单） ---------------- */
  'd19-diag': {
    pluginId: 'builtin:d19-diag',
    system: D19_DIAG_SYSTEM,
    fields: [
      // 用户勾选模块即授权 → locked；目标岗位名是用户在面板里输入的 → 默认勾、可取消
      { name: 'selectedModules', label: '选中的简历模块', value: '', locked: true },
      { name: 'targetJobTitle', label: '目标岗位名', value: '', defaultChecked: true },
      // basics 联系类字段（姓名/电话/邮箱/照片/城市）不在字段表 —— 没有开关，不是默认不勾
    ],
  },
  'd19-polish': {
    pluginId: 'builtin:d19-polish',
    targetType: 'resume_field',
    system: D19_POLISH_SYSTEM,
    fields: [
      { name: 'selectedText', label: '选中段落原文', value: '', locked: true },
      { name: 'sectionLabel', label: '所属板块', value: '', locked: true },
    ],
  },
  'd19-jd': {
    pluginId: 'builtin:d19-jd',
    targetType: 'resume_field',
    system: D19_JD_SYSTEM,
    fields: [
      { name: 'jdText', label: '岗位 JD 原文', value: '', locked: true },
      { name: 'selectedModules', label: '选中的简历模块', value: '', locked: true },
    ],
  },
  /* ---------------- v0.9 / R-AI-11：面经整段极速录入（与 d14 并列，A-14） ---------------- */
  'd14-bulk': {
    pluginId: 'builtin:d14-bulk',
    targetType: 'question',
    system: D14_BULK_SYSTEM,
    fields: [
      // 出境口径与 d14 完全一致（验收 29）：整段原文必发，公司/岗位默认不勾。
      // interviewDate / round 不在字段表 —— 结构上发不出去，日期永远不由 AI 提供。
      { name: 'note', label: '面经整段原文', value: '', locked: true },
      { name: 'companyName', label: '公司名', value: '', defaultChecked: false },
      { name: 'jobTitle', label: '岗位名', value: '', defaultChecked: false },
    ],
  },
  'd20-analysis': {
    pluginId: 'builtin:d20-analysis',
    system: D20_SYSTEM,
    fields: [
      // JD 留档是用户此前粘贴的 → 默认勾、可取消；库内简历模块按铁律默认不勾
      { name: 'jdText', label: 'JD 留档原文', value: '', defaultChecked: true },
      { name: 'companyName', label: '公司名', value: '' },
      { name: 'jobTitle', label: '岗位名', value: '' },
      { name: 'status', label: '当前状态', value: '' },
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
