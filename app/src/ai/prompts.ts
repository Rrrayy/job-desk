/**
 * 内置 AI 场景的字段声明与提示词（v0.8 / T03；v0.10 全面重写）。
 *
 * v0.10 的 prompt 与 v0.9 的三点不同：
 * 1. **每条都带正例与反例**。v0.9 只写「输出必须是 JSON」，模型仍然会加
 *    「好的，我整理如下」或用 ```json 围栏 —— 反例把这种失败模式写死。
 * 2. **证据要求写成硬约束**：可以引用的原句必须来自输入，否则不给该字段。
 *    解析侧还有 `evidence.ts` 做二次核对，两边合起来才算「可追溯」。
 * 3. **每条都带自检清单**：模型在输出前自查一遍，比事后解析器补救便宜。
 *
 * 体积从 ~3 KB 涨到 ~9 KB，是这一轮刻意花的钱：prompt 是唯一直接影响
 * 分析质量的东西，省它等于省产品的上限。
 *
 * 字段名与 Application/StagedSyncItem 的键对齐，D13 预览按 name 分组：
 * companyName/jobTitle/status 默认勾选；round/interviewKind/writtenResult/
 * 面经原文等新增出境字段默认**不**勾选。
 */

import type { AISuggestionTargetType } from '../types';
import type { AiScenarioKey, ChatMessage, PreviewField } from './types';

export interface AiScenarioSpec {
  /** 内置场景固定前缀 builtin:（与插件 pluginId 同一命名空间） */
  pluginId: string;
  /** 建议类场景的写回通道；报告类场景（d19-diag/d20-analysis）不产出建议，缺省 */
  targetType?: AISuggestionTargetType;
  /** ≤16 行的紧凑 system 提示（v0.10 起允许写正例/反例，仍不写长文） */
  system: string;
  /** 出境字段声明（locked = 必发，其余默认不勾） */
  fields: PreviewField[];
}

/**
 * 解析失败时的第二次请求（v0.10 / L2-3）。
 *
 * 只在解析器说「不 ok」时发送一次，带 temperature 0 ——
 * 目的不是让模型重新回答，而是让它**把已有的回答重排成约定格式**。
 * 所以消息里保留了它上一次的原始输出，指令只谈格式，不谈内容。
 */
export const REPAIR_INSTRUCTION = [
  '你上一条回复不是约定的格式，无法被程序解析。',
  '请把上一条回复的内容**原样**重排成系统提示要求的单个 JSON 对象：',
  '- 只输出 JSON 本身，前后不要任何解释；',
  '- 不要用 Markdown 围栏包裹；',
  '- 键名与系统提示完全一致；',
  '- 不要把没提到的内容补进去。',
].join('\n');

/**
 * 修复请求的消息：原对话 + 模型上次的原始输出 + 修复指令。
 *
 * 为什么保留原对话：修复不是重答。把 system 与 user 一起去掉，模型就不知道
 * 「约定的格式」是什么；只留原始输出，它会当成新任务重新发挥。
 * 原始输出截 6000 字：真的更长的回复，说明格式已经乱到没法就地重排。
 */
export function buildRepairMessages(messages: ChatMessage[], raw: string): ChatMessage[] {
  return [
    ...messages,
    { role: 'assistant', content: raw.slice(0, 6000) },
    { role: 'user', content: REPAIR_INSTRUCTION },
  ];
}

/** 所有场景共用的一句：它比任何「请仔细」都更能减少胡编 */
const NO_INVENTION = '如果输入里没有某项信息，就省略该字段或用 not_found 标记，禁止猜测、禁止用「暂无/未知」占位。';

const D14_SYSTEM = [
  '你是面试复盘助手。输入是一段面经笔记（口语、错别字、中英混杂都正常）。',
  '任务：提取「面试官问了什么」，每题一行，格式：题目 | 类别(algo/concept/project/behavior/reverse/hr)。',
  '规则：',
  '1. 只提取笔记里真实出现的题，禁止猜；题干保持原意，可轻度精简口语与重复。',
  '2. 不输出答案；候选人自己的回答不是题。',
  '3. 同一道题的追问合并成一条；重复出现的题只留一条。',
  '4. 寒暄、自我介绍、反问环节本身不算题，除非面试官明确提问。',
  '正例：{"questions":[{"text":"手写防抖函数","category":"algo"},{"text":"Vue 响应式原理","category":"concept"}]}',
  '反例（判失败）：JSON 前后加「好的」；用 ```json 包裹；把「一面 40 分钟」当题；编一道笔记里没有的题。',
  '输出必须是单个 JSON 对象：{"questions":[{"text":"...","category":"algo"}]}，除此之外不要任何文字。',
].join('\n');

const D15_SYSTEM = [
  '你是求职沟通助手。输入是岗位上下文与最近沟通记录。',
  '任务：起草一条发给 HR/面试官的中文消息（跟进进度 / 约时间 / 表示感谢）。',
  '规则：',
  '1. 120 字以内，口语化，像真人发的消息。',
  '2. 不谄媚、不堆敬语，不用「贵司」以外的套话。',
  '3. 不编造事实：没提到的经历、时间、结果一律不写。',
  '4. 不写占位符（如「[HR 姓名]」「XX 公司」）；称呼不确定就用「您好」。',
  '5. 只写一条消息，不要给多个版本让我们挑。',
  '正例：{"draft":"您好，我是上周三面完二面的候选人。想确认一下后续流程大概什么时候会有结果，方便我安排时间。谢谢！"}',
  '反例（判失败）：写三段不同语气让人选；出现「贵公司是一家非常有前景的企业」这类空话；编一个不存在的面试时间。',
  '输出必须是单个 JSON 对象：{"draft":"..."}，除此之外不要任何文字。',
].join('\n');

const D17_SYSTEM = [
  '你是表格解析助手。输入是招聘平台页面的原始文本片段（正则解析失败时的兜底）。',
  '任务：识别一条求职记录的公司名 / 岗位名 / 状态 / 城市 / 薪资。',
  `规则：${NO_INVENTION}`,
  '状态只能取：想投/已投/沟通中/笔试/已约面/面试中/offer/已入职/已拒绝/已放弃。',
  'evidence 必须是输入里**连续出现**的原文片段（一字不改，便于程序回查）。找不到依据就不要输出这个字段。',
  '正例：{"fields":[{"field":"companyName","value":"字节跳动","evidence":"字节跳动"},{"field":"jobTitle","value":"前端开发实习生","evidence":"前端开发实习生"}]}',
  '反例（判失败）：evidence 写「根据页面内容判断」；把「薪资面议」填成「20k」；输出表格或 Markdown。',
  '输出必须是单个 JSON 对象：{"fields":[{"field":"companyName","value":"...","evidence":"原文片段"}]}，不要任何其他文字。',
].join('\n');

/**
 * v0.9 四个场景共用的开场（PRD §10）：省的是每个 system 重复的边界声明。
 * 「联系方式不会出现在输入里」不是承诺，是 context.ts 的结构保证 —— 这里只是告诉模型别问。
 */
const T07_PREAMBLE = '你是简历与求职助手。输入只包含用户主动选择的内容；姓名、电话、邮箱、照片等联系方式不会出现，也不要索要。';

const D19_DIAG_SYSTEM = [
  T07_PREAMBLE,
  '你是简历诊断教练。输入是候选人的 1–3 个简历模块文本与目标岗位名。',
  '任务：对照目标岗位逐维度判断匹配度，每个维度给出两边的证据原句。',
  'verdict 只能是 strong_match / partial_match / gap / not_found：',
  '- strong_match：简历里有明确对应且有产出/数字；',
  '- partial_match：有相关经历但不直接对应；',
  '- gap：岗位明显要求而简历没有；',
  '- not_found：材料里没提到，无法判断（**不要用 gap 代替 not_found**）。',
  'evidenceFromResume 必须从输入的模块文本里原样摘句（一字不改）；摘不出就填 not_found。',
  'evidenceFromJd 同样必须来自目标岗位描述；用户只给了岗位名时，用岗位名本身作为依据。',
  '维度建议固定六项：技能匹配 / 项目相关度 / 经历年限 / 成果量化 / 技术深度 / 表达清晰度。',
  `规则：${NO_INVENTION}`,
  '正例：{"summary":"技能与项目方向匹配，但缺量化成果。","next_steps":["把第二个项目的性能优化补上具体数字"],"dimensions":[{"key":"skills","label":"技能匹配","verdict":"strong_match","evidenceFromResume":"熟悉 Vue 3 与 TypeScript","evidenceFromJd":"前端开发实习生","gapDescription":""}]}',
  '反例（判失败）：所有维度都给 strong_match；给一个 87 分；evidenceFromResume 编一句简历里没有的话。',
  '输出必须是单个 JSON 对象：{"summary":"两句话总评","next_steps":["最优先的一步"],"dimensions":[{"key":"k","label":"维度","verdict":"gap","evidenceFromResume":"简历原句","evidenceFromJd":"JD 原句","gapDescription":"差在哪"}]}，除此之外不要任何文字。',
].join('\n');

const D19_POLISH_SYSTEM = [
  T07_PREAMBLE,
  '你是简历润色助手。输入是一段简历原文与它所在的板块名。',
  '任务：改写成「动词开头、尽量带数字」的中文简历句。',
  '规则：',
  '1. 只改表达，不改事实：不发散、不合并两件事、不编造原文没有的数字或技术名词。',
  '2. 保留专有名词原样（框架名、公司名、指标名）。',
  '3. 一条一段，不要加小标题、不要加「•」。',
  '4. 原文已经足够好时，少改比多改好。',
  '正例：{"polished":"优化首页渲染流程，首屏时间从 2.1s 降到 0.9s","reasons":["动词开头","补上了原文已有的数字"]}',
  '反例（判失败）：把「参与」改成「主导」（事实升级）；加一个原文没有的「提升 30%」；输出三条不同版本。',
  '输出必须是单个 JSON 对象：{"polished":"改写后的整段","reasons":["为什么这样改"]}，除此之外不要任何文字。',
].join('\n');

const D19_JD_SYSTEM = [
  T07_PREAMBLE,
  '你是简历定向改写助手。输入是一份 JD 与候选人的若干简历模块（每行以字段名开头，如 description: …）。',
  '任务：对照 JD 挑出值得改写的字段，产出改写建议。',
  '规则：',
  '1. fieldPath 必须用输入里出现过的字段名（description / skillsText / customText 等），不许自创。',
  '2. 只基于候选人已有经历改写，不编造新经历、新数字。',
  '3. 每条建议附 JD 依据原句；找不到依据的改写不要提。',
  '4. 优先级：JD 明确要求而简历弱表达的 > 措辞可优化的；最多 6 条，少于 6 条就少给。',
  '5. 同一条建议只针对一个字段，不要给出整份简历。',
  '正例：{"suggestions":[{"fieldPath":"description","content":"用 React Hooks 重构订单页，组件复用率提升，维护成本下降","evidence":"熟悉 React Hooks 与组件化开发"}]}',
  '反例（判失败）：fieldPath 写「工作经历」；编一个 JD 里没提的技术栈；把同一段话拆成五条凑数。',
  '输出必须是单个 JSON 对象：{"suggestions":[{"fieldPath":"description","content":"改写后的内容","evidence":"JD 原句"}]}，不要任何其他文字。',
].join('\n');

const D20_SYSTEM = [
  T07_PREAMBLE,
  '你是求职竞争力分析师。输入是一份 JD、公司/岗位/状态，以及**候选人的简历模块（可能为空）**。',
  '任务：判断候选人与这个岗位的匹配度，给出两句话总评与下一步建议。',
  '关键约束：',
  '1. 如果输入里有简历模块，evidenceFromResume 必须从模块原文里原样摘句（一字不改）。',
  '2. 如果输入里没有简历模块，所有维度一律 not_found，summary 里说明「未提供简历，无法判断匹配度」——**绝不凭 JD 猜候选人**。',
  '3. verdict 只能是 strong_match / partial_match / gap / not_found。',
  '4. 不要打总分、不要给百分比；分数由程序按维度合成。',
  '维度建议固定五项：硬性要求 / 技术栈 / 项目相关度 / 经验年限 / 软性素质。',
  `规则：${NO_INVENTION}`,
  '正例（有简历）：{"summary":"技术栈基本对齐，项目经验偏浅。","next_steps":["补一个与 JD 主技术栈一致的项目"],"dimensions":[{"key":"stack","label":"技术栈","verdict":"partial_match","evidenceFromResume":"熟悉 Vue 3","evidenceFromJd":"要求 React 18","gapDescription":"框架不一致但组件化经验可迁移"}]}',
  '反例（判失败）：没给简历却给出 80 分；evidenceFromResume 写「候选人经验丰富」；summary 里复述 JD。',
  '输出必须是单个 JSON 对象：{"summary":"两句话总评","next_steps":["下一步"],"dimensions":[{"key":"k","label":"维度","verdict":"gap","evidenceFromResume":"依据原句","evidenceFromJd":"JD 原句"}]}，除此之外不要任何文字。',
].join('\n');

const D14_BULK_SYSTEM = [
  T07_PREAMBLE,
  '你是面经整理助手。输入是一整段面试记录（可能包含多轮、口语、流水账）。',
  '任务① questions：把记录拆成一道道题，每题给出题干与类别（algo/concept/project/behavior/reverse/hr 之一）；候选人当时的回答放 myAnswer，没有就省略。只拆真实出现的题，不编造。',
  '任务② unmatched：没识别成题目的原文段落原样保留，一段一项，**绝不丢弃**（用户宁可看到一段原文，也不要内容消失）。',
  '任务③ head：记录里明确出现的公司名/岗位名/轮次；没有就不要给。',
  '规则：',
  '1. 题干可轻度精简，但不能改变问的是什么。',
  '2. 同一题的追问合并成一条；不同轮的同类题分开保留。',
  '3. 不要输出答案，不要把候选人的回答改写成题。',
  '正例：{"head":{"companyName":"字节跳动","round":2},"questions":[{"text":"实现一个 LRU 缓存","category":"algo","myAnswer":"用 Map 加双向链表"}],"unmatched":["面试官最后介绍了团队业务"]}',
  '反例（判失败）：把 unmatched 丢掉；把「面试官介绍了团队」编成一道题；整段输出成 Markdown 列表。',
  '输出必须是单个 JSON 对象：{"head":{"companyName":"..."},"questions":[{"text":"...","category":"algo","myAnswer":"..."}],"unmatched":["..."]}，除此之外不要任何文字。',
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
      // ★ v0.10 / L2-1：没有这一项，「竞争力分析」就只是在分析 JD。
      //   默认不勾（铁律：库内数据默认不出境），但**有勾选框**了。
      { name: 'selectedModules', label: '选中的简历模块', value: '', defaultChecked: false },
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

/**
 * 场景级生成参数（v0.10 / L2-5）。
 *
 * 解析与诊断类固定 0 度：我们要的是「照着材料说话」，不是「发挥」。
 * 生成类给 0.3：话术与润色需要一点措辞变化，但不需要创意。
 * 一律带 `jsonMode: true`（服务端不认时网关会自动降级，用户无感）。
 */
export function scenarioParams(key: AiScenarioKey): {
  temperature: number;
  jsonMode: boolean;
} {
  const deterministic = key === 'd14' || key === 'd17' || key === 'd19-diag' || key === 'd19-jd' || key === 'd20-analysis';
  return { temperature: deterministic ? 0 : 0.3, jsonMode: true };
}
