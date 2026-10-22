/**
 * 三个内置 AI 场景的运行时纯函数（v0.8 / T05：D14 面经整理 / D15 话术草稿 / D17 辅助解析）。
 *
 * 为什么单独一层（而不是塞进面板组件）：面板负责「让用户看清并勾选」，
 * 这一层负责「勾选的字段 → 请求消息」和「模型输出 → 建议条目」。两边都是纯函数，
 * 于是验收 11 那句「断言请求体仅含粘贴原文」可以写成一行断言，而不是靠读组件源码。
 *
 * ★ 三条不可动摇的纪律：
 * 1. 请求消息**只由 checked 里的字段拼**。勾选之外的值一个字符都不进 messages ——
 *    这是 D13 预览弹层的存在意义，任何「顺便带上库里的 X 做上下文」都是对它的背叛。
 * 2. 模型输出必须过窄校验。解析失败 = 诚实报错 + 零写入，绝不猜、绝不半写。
 * 3. 场景产出统一是 AISuggestion（pending），用户勾选才落库（ai/suggestions.ts）。
 */

import type { AiScenarioKey, ChatMessage, NewAISuggestion, PreviewField } from './types';
import { AI_SCENARIOS, previewFieldsOf } from './prompts';

/** 单次最多接受多少道题（模型偶尔会把整段笔记拆成几十行，多到没法逐条看） */
export const MAX_AI_QUESTIONS = 30;
/** 题干截断长度（Question.text 上限 2000，但 AI 摘出来的题不该有段落那么长） */
const QUESTION_CHARS = 300;
/** 话术草稿截断长度（D15 要求 120 字左右，留足余量给模型超写） */
const DRAFT_CHARS = 500;
/** D17 允许模型回填的字段白名单 —— 与 NormalizedRecord 的键同名，别的键一律丢 */
const STAGING_AI_FIELDS = ['companyName', 'jobTitle', 'status', 'city', 'salaryText'] as const;

/** 一条场景建议的中间形态（field 在 D14 是 'text'、D15 是 'content'、D17 是字段名） */
export interface AiItem {
  field: string;
  value: string;
  evidence?: string;
}

export type ScenarioParse = { ok: true; items: AiItem[] } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 从模型输出里抠出第一个 JSON 对象（容忍 ```json 围栏与前后废话） */
function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 勾选字段 → chat messages。**只读 checked**，不读任何上下文对象。
 *
 * D17 特例（验收 11）：user 消息就是粘贴原文本身，不加标签、不拼前缀 ——
 * 这样「实际发出去的内容 == 用户粘贴的内容」是一个可断言的等式，而不是一句承诺。
 */
export function buildScenarioMessages(key: AiScenarioKey, checked: Record<string, string>): ChatMessage[] {
  const spec = AI_SCENARIOS[key];
  const system: ChatMessage = { role: 'system', content: spec.system };
  if (key === 'd17') return [system, { role: 'user', content: checked.rawSnippet ?? '' }];

  const parts: string[] = [];
  for (const field of spec.fields) {
    const value = checked[field.name];
    if (value && value.trim()) parts.push(`${field.label}：${value.trim()}`);
  }
  return [system, { role: 'user', content: parts.join('\n') }];
}

/** 场景的出境字段声明（value 由面板按上下文填充；locked/defaultChecked 口径在 prompts.ts） */
export function scenarioPreviewFields(key: AiScenarioKey, values: Record<string, string>): PreviewField[] {
  return previewFieldsOf(AI_SCENARIOS[key], values);
}

/** D14：JSON 解析不出来时的兜底（一行一题，`题干 | 类别`） */
function parseQuestionLines(text: string): AiItem[] {
  const items: AiItem[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/```[a-z]*/gi, '').replace(/^[\s\-*•\d.、)）|]+/, '').trim();
    if (!line || line.startsWith('{') || line.startsWith('"') || line.startsWith('[')) continue;
    const [question] = line.split('|');
    const trimmed = question.trim();
    if (trimmed) items.push({ field: 'text', value: trimmed.slice(0, QUESTION_CHARS) });
    if (items.length >= MAX_AI_QUESTIONS) break;
  }
  return items;
}

/** D14：`{"questions":[{"text":"…","category":"algo"}]}` → 逐题建议 */
function parseQuestions(raw: string): ScenarioParse {
  const payload = extractJson(raw);
  const list = isRecord(payload) && Array.isArray(payload.questions) ? payload.questions : null;
  const items: AiItem[] = [];
  if (list) {
    for (const entry of list) {
      const text = typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.text === 'string' ? entry.text : '';
      const trimmed = text.trim();
      if (trimmed) items.push({ field: 'text', value: trimmed.slice(0, QUESTION_CHARS) });
      if (items.length >= MAX_AI_QUESTIONS) break;
    }
  }
  // 模型偶尔不按 JSON 输出。这里不报错，按「一行一题」读一遍 ——
  // 但读不出任何东西时绝不假装成功（那会让用户以为模型什么都没找到）。
  const finalItems = items.length > 0 ? items : parseQuestionLines(raw);
  if (finalItems.length === 0) {
    return { ok: false, error: '模型没有从这段文字里认出题目 —— 再试一次，或直接手动加题' };
  }
  return { ok: true, items: finalItems };
}

/** D15：`{"draft":"…"}` → 一段话术（模型直接回纯文本也接受） */
function parseDraft(raw: string): ScenarioParse {
  const payload = extractJson(raw);
  const body =
    isRecord(payload) && typeof payload.draft === 'string'
      ? payload.draft
      : raw.replace(/```[a-z]*/gi, '');
  const value = body.trim().slice(0, DRAFT_CHARS);
  if (!value) return { ok: false, error: '模型返回了空内容，这次没有生成任何建议' };
  return { ok: true, items: [{ field: 'content', value }] };
}

/**
 * D17：`{"fields":[{"field":"companyName","value":"…","evidence":"原文片段"}]}`
 * → 逐字段建议 + 证据。未知字段、空值、重复字段一律丢（**不猜**）。
 */
function parseStagingFields(raw: string): ScenarioParse {
  const payload = extractJson(raw);
  const list = isRecord(payload) && Array.isArray(payload.fields) ? payload.fields : null;
  if (!list) {
    return {
      ok: false,
      error: '模型返回的不是约定的 JSON（{fields:[{field,value,evidence}]}）—— 这次没有写入任何字段，可以重试',
    };
  }
  const items: AiItem[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const field = typeof entry.field === 'string' ? entry.field.trim() : '';
    const value = typeof entry.value === 'string' ? entry.value.trim() : '';
    if (!(STAGING_AI_FIELDS as readonly string[]).includes(field) || !value || seen.has(field)) continue;
    seen.add(field);
    const evidence = typeof entry.evidence === 'string' ? entry.evidence.trim().slice(0, 300) : '';
    items.push({ field, value: value.slice(0, 200), ...(evidence ? { evidence } : {}) });
  }
  if (items.length === 0) {
    return { ok: false, error: '模型没有给出可用字段（可能这一段确实没有公司名）—— 未写入任何内容' };
  }
  return { ok: true, items };
}

/** 按场景分派解析；三种输出形状完全不同，所以这里必须显式分支 */
export function parseScenarioOutput(key: AiScenarioKey, raw: string): ScenarioParse {
  if (key === 'd14') return parseQuestions(raw);
  if (key === 'd15') return parseDraft(raw);
  return parseStagingFields(raw);
}

/** 解析结果 → 待入库的建议（status/createdAt 由 suggestions.createSuggestions 补） */
export function toNewSuggestions(
  key: AiScenarioKey,
  targetId: string | null,
  items: AiItem[],
): NewAISuggestion[] {
  const spec = AI_SCENARIOS[key];
  return items.map((item) => ({
    pluginId: spec.pluginId,
    targetType: spec.targetType,
    targetId,
    fieldPath: item.field,
    content: item.value,
    ...(item.evidence ? { evidence: item.evidence } : {}),
  }));
}

/** 该场景的建议归属（面板按 pluginId + targetId 过滤出「这一屏待确认的建议」） */
export function scenarioPluginId(key: AiScenarioKey): string {
  return AI_SCENARIOS[key].pluginId;
}
