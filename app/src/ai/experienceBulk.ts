/**
 * R-AI-11 面经整段极速录入（v0.9 / T07b）。
 *
 * 两个职责，一进一出：
 * 1. **进**（`parseBulkOutput`）：模型输出 → `{items, head, unmatched, truncated}`。
 *    八条窄校验在这里逐条落地 —— 编号/类别**不听模型的**（ref 忽略、非法 category 落
 *    null），不吞原文（unmatched 原样保留），超限不静默（只留前 50 + truncated 计数）。
 * 2. **出**（`applyBulkAdoption`）：全仓唯一能一次建「1 面经 + N 题」的地方。
 *    前置校验全部在写入之前（mutate 没有回滚：中途 return 等于把半成品提交了）；
 *    删行走 `AiUndo.createdExperiences`、字段回写走 `AiUndoTarget`（A-16 分工）。
 */

import type { DB, QuestionCategory } from '../types';
import { BULK_LIMITS, UNMATCHED_NOTE_PREFIX } from '../types';
import type { AiUndo, BulkHeadSuggestion, NewAISuggestion } from './types';
import { CATEGORY_OPTIONS } from '../lib/interview';
import { uid } from '../lib/util';
import { extractJson, isRecord, parseQuestionLines } from './scenarios';
import { applySuggestions } from './suggestions';

/* ------------------------------ 解析 ------------------------------ */

/** 一道拆出来的题：题干在 text，类别已窄校验（非法落 null），回答空则省略键 */
export interface BulkItem {
  text: string;
  category: QuestionCategory | null;
  myAnswer?: string;
}

export interface BulkParsed {
  items: BulkItem[];
  /** AI 对头部的建议（只做 chip 提示，不覆盖用户已填）；模型没给就没有 */
  head?: BulkHeadSuggestion;
  /** 未识别为题目的原文段落（每段 ≤500 字、最多 20 段） */
  unmatched: string[];
  /** 被省略的条数（超 50 的题目 + 超 20 段的未识别段落）—— UI 必须注明，不静默 */
  truncated: number;
}

export type BulkParse = { ok: true; parsed: BulkParsed } | { ok: false; error: string };

/**
 * 模型输出 → 拆分结果（八条窄校验，ARCH §2.5）。
 * 解析器**根本不读** `ref` 字段 —— 编号由 `applyBulkAdoption` 按列表顺序生成（1..N）。
 */
export function parseBulkOutput(raw: string): BulkParse {
  const payload = extractJson(raw);
  const list = isRecord(payload) && Array.isArray(payload.questions) ? payload.questions : null;
  const items: BulkItem[] = [];
  if (list) {
    const seen = new Set<string>();
    for (const entry of list) {
      if (!isRecord(entry)) continue;
      const text = typeof entry.text === 'string' ? entry.text.trim().slice(0, BULK_LIMITS.questionChars) : '';
      // 空题干丢弃；同批次重复（小写比较）丢弃 —— 与 D14 的去重口径一致
      if (!text || seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      const category =
        typeof entry.category === 'string' && (CATEGORY_OPTIONS as string[]).includes(entry.category)
          ? (entry.category as QuestionCategory)
          : null; // 非法类别落 null，绝不写非法值
      const myAnswer = typeof entry.myAnswer === 'string' ? entry.myAnswer.trim() : '';
      items.push({
        text,
        category,
        ...(myAnswer ? { myAnswer: myAnswer.slice(0, BULK_LIMITS.answerChars) } : {}),
      });
    }
  }
  // questions 非数组 → 「一行一题」兜底（复用 D14 的 parseQuestionLines，不复制）。
  // 守卫：只有多行文本才配得上兜底 —— 单行废话（模型把整段原文当题干吐回来）
  // 必须诚实报错，而不是变出一道假题（验收 28：0 题 → 诚实报错 + 零写入）。
  const finalItems: BulkItem[] =
    items.length > 0
      ? items
      : raw.trim().includes('\n')
        ? parseQuestionLines(raw).map((line) => ({ text: line.value, category: null }))
        : [];
  if (finalItems.length === 0) {
    return { ok: false, error: '模型没有从这段记录里认出题目 —— 再试一次，或改用「一行一题」手记' };
  }

  // 上限 50 题：只保留前 50 + truncated 计数 —— 不静默截断
  let truncated = Math.max(0, finalItems.length - BULK_LIMITS.maxQuestions);

  // unmatched：每段 ≤500 字、最多 20 段；超出丢弃并计入 truncated（UI 注明，不静默）
  const unmatched: string[] = [];
  if (isRecord(payload) && Array.isArray(payload.unmatched)) {
    for (const entry of payload.unmatched) {
      if (typeof entry !== 'string' || !entry.trim()) continue;
      if (unmatched.length >= BULK_LIMITS.maxUnmatched) {
        truncated += 1;
        continue;
      }
      unmatched.push(entry.trim().slice(0, BULK_LIMITS.unmatchedChars));
    }
  }

  // head 只做建议：三个字段各自窄校验，模型没给/类型不对就不带
  let head: BulkHeadSuggestion | undefined;
  if (isRecord(payload) && isRecord(payload.head)) {
    const rawHead = payload.head;
    const companyName = typeof rawHead.companyName === 'string' ? rawHead.companyName.trim() : '';
    const jobTitle = typeof rawHead.jobTitle === 'string' ? rawHead.jobTitle.trim() : '';
    const round = typeof rawHead.round === 'number' && Number.isFinite(rawHead.round) ? rawHead.round : null;
    if (companyName || jobTitle || round !== null) {
      head = {
        ...(companyName ? { companyName } : {}),
        ...(jobTitle ? { jobTitle } : {}),
        round,
      };
    }
  }

  return {
    ok: true,
    parsed: {
      items: finalItems.slice(0, BULK_LIMITS.maxQuestions),
      ...(head ? { head } : {}),
      unmatched,
      truncated,
    },
  };
}

/** d14-bulk 的建议形状：题干在 content，类别/我的回答在 meta（targetId=null，接受时才建行） */
export function bulkItemsToSuggestions(
  pluginId: string,
  items: BulkItem[],
): NewAISuggestion[] {
  return items.map((item) => ({
    pluginId,
    targetType: 'question',
    targetId: null,
    fieldPath: 'text',
    content: item.text,
    ...(item.category !== null || item.myAnswer
      ? { meta: { ...(item.category !== null ? { category: item.category } : {}), ...(item.myAnswer ? { myAnswer: item.myAnswer } : {}) } }
      : {}),
  }));
}

/* ------------------------------ 采用 ------------------------------ */

/** 一次「全部采用」的入参（全仓唯一新增的写入口，ARCH §2.5 数据契约） */
export interface BulkAdoptInput {
  head: {
    companyName: string;
    jobTitle?: string;
    interviewDate: string;
    round?: number | null;
    applicationId?: string | null;
  };
  suggestionIds: string[];
  /** 勾了「留作备注」的未识别段落（已 ≤500 字/段、≤20 段） */
  unmatchedKeep: string[];
  /** 勾了「丢掉」的段数：只用于 toast，不落库 */
  unmatchedDropped: number;
  /** 补录入口（ExperienceEditor）：为已有面经追加，此时**不新建** experience */
  existingExperienceId?: string;
}

export type BulkAdoptResult =
  | { ok: true; experienceId: string; created: number; dropped: number }
  | { ok: false; error: string };

/**
 * 一次「全部采用」= 一次 mutate 内完成：建壳（或复用补录壳）→ unmatched 写 overallNote
 * → 复用 applySuggestions 建 N 题 → 回填 order 1..N → 交出复合撤销单元。
 * 前置校验**必须全部在写入之前**：mutate 没有回滚，中途 return 就是提交半成品。
 */
export function applyBulkAdoption(
  db: DB,
  input: BulkAdoptInput,
  opts: { nowIso: string },
): { ok: true; undo: AiUndo; experienceId: string; created: number } | { ok: false; error: string } {
  // 0. 前置校验（写入之前）
  if (!input.head.companyName.trim()) return { ok: false, error: '先填公司名 —— 只填这一个也能存' };
  const ids = new Set(input.suggestionIds);
  if (ids.size === 0) return { ok: false, error: '一道题都没勾 —— 至少选一条，或取消本次录入' };
  const pending = db.aiSuggestions.filter((item) => ids.has(item.id) && item.status === 'pending');
  if (pending.length === 0) return { ok: false, error: '这些建议已处理过，没有可写入的内容' };

  // 1. 建壳（补录路径跳过，复用 existingExperienceId —— 不新建第二种壳）
  let experienceId = input.existingExperienceId ?? null;
  const createdExperiences: string[] = [];
  if (experienceId) {
    const existing = db.experiences.find((item) => item.id === experienceId);
    if (!existing) return { ok: false, error: '要补录的面经已被删除 —— 刷新后重试' };
  } else {
    experienceId = uid('exp');
    // 与 QuickNote 的壳字段完全一致，不自造第二种壳
    db.experiences.push({
      id: experienceId,
      applicationId: input.head.applicationId ?? null,
      companyName: input.head.companyName.trim(),
      jobTitle: input.head.jobTitle?.trim() || undefined,
      round: input.head.round ?? null,
      interviewDate: input.head.interviewDate,
      result: 'pending',
      source: 'self',
      createdAt: opts.nowIso,
      updatedAt: opts.nowIso,
    });
    createdExperiences.push(experienceId);
  }

  // 2. 未识别段落 → overallNote 末尾（前缀固定；有原值则换行追加，不覆盖）
  const targets: AiUndo['targets'] = [];
  if (input.unmatchedKeep.length > 0) {
    const experience = db.experiences.find((item) => item.id === experienceId);
    if (experience) {
      const prevValue = experience.overallNote; // undefined = 原本没有这个键
      const block = [UNMATCHED_NOTE_PREFIX, ...input.unmatchedKeep].join('\n');
      experience.overallNote = prevValue ? `${prevValue}\n\n${block}` : block;
      experience.updatedAt = opts.nowIso;
      targets.push({
        table: 'experiences',
        id: experienceId,
        field: 'overallNote',
        prevValue,
        rowExisted: true,
      });
    }
  }

  // 3. 复用 applySuggestions：targetType='question' && targetId=null 本来就会新建 Question 行
  const applied = applySuggestions(db, ids, {
    nowIso: opts.nowIso,
    resolveQuestionExperienceId: () => experienceId,
  });

  // 4. 回填 order = 1..N（按本次新建行的插入顺序；同一循环完成，不第二遍扫描）
  let seq = 0;
  for (const target of applied.undo.targets) {
    if (target.table !== 'questions' || target.rowExisted) continue; // 只给本次新建的行编号
    const row = db.questions.find((item) => item.id === target.id);
    if (row) row.order = ++seq; // 1..N，代码生成（模型自报的 ref 一律没读过）
  }

  // 5. 复合撤销单元：删行走 createdExperiences，字段回写走 targets（A-16）
  return {
    ok: true,
    created: applied.applied,
    experienceId,
    undo: { ...applied.undo, targets: [...targets, ...applied.undo.targets], createdExperiences },
  };
}
