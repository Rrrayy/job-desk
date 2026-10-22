/**
 * AISuggestion 生命周期纯函数（v0.8 / T03，ARCH §1.5）。
 *
 * 链路：提案（场景/插件产出）→ pending → 用户勾选 → **单次 mutate** 内
 * 按 targetType 写目标表 + status='accepted' + 一个 `pushUndo({kind:'ai'})`
 * → ⌘Z 用 AiUndo 整体回退 → rejected/accepted 留 7 天后启动 sweep 清理。
 *
 * ★ 函数族按「mutate recipe 内的就地编辑」设计：调用方（App）传进来的是
 * cloneDB 出来的草稿，这里直接改、不返回新库 —— 与 revertStatusChange 同款。
 * 测试要纯语义时自己先 clone 一份。
 */

import type {
  AISuggestion,
  AISuggestionStatus,
  DB,
  Note,
  Question,
  ResumeSection,
} from '../types';
import { uid } from '../lib/util';
import { FIELD_META } from '../resume/templates/base';
import type { AiUndo, AiUndoTarget, NewAISuggestion } from './types';
import type { AISuggestionMeta } from '../types';

/** 简历行是否在回收站（与 lib/trash.isDeleted 同口径；就地实现避免 trash ↔ ai 循环导入） */
function resumeGone(resume: { deletedAt?: string | null }): boolean {
  return typeof resume.deletedAt === 'string' && resume.deletedAt.length > 0;
}

/**
 * 润色建议的 fieldPath（`s:{sectionId}:i:{itemId}:{fieldKey}`）→ 落点三元组。
 * 解析不出来（格式不对）返回 null —— 模型/面板给的路径不可信，落点必须可验证。
 */
export function parseResumeFieldPath(fieldPath: string): { sectionId: string; itemId: string; key: string } | null {
  const parts = fieldPath.split(':');
  if (parts.length < 5 || parts[0] !== 's' || parts[2] !== 'i') return null;
  const key = parts.slice(4).join(':');
  if (!parts[1] || !parts[3] || !key) return null;
  return { sectionId: parts[1], itemId: parts[3], key };
}

function resumeItemOf(resume: { content: { sections: ResumeSection[] } }, fieldPath: string) {
  const parsed = parseResumeFieldPath(fieldPath);
  if (!parsed) return null;
  const section = resume.content.sections.find((item) => item.id === parsed.sectionId);
  const item = section?.items.find((entry) => entry.id === parsed.itemId);
  if (!section || !item) return null;
  return { ...parsed, item };
}

/** rejected/accepted 建议的保留天数（超期由启动 sweep 清理） */
export const SUGGESTION_RETENTION_DAYS = 7;

const DAY_MS = 86_400_000;

/* ------------------------------ 提案 ------------------------------ */

/** 场景/插件的建议统一从这里入库：补 id、status='pending'、createdAt */
export function createSuggestions(inputs: NewAISuggestion[], nowIso: string): AISuggestion[] {
  return inputs.map((input) => ({
    id: uid('sugg'),
    pluginId: input.pluginId,
    targetType: input.targetType,
    targetId: input.targetId,
    fieldPath: input.fieldPath,
    content: input.content,
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.meta ? { meta: input.meta } : {}),
    status: 'pending' as const,
    createdAt: nowIso,
  }));
}

/* ------------------------------ 确认 ------------------------------ */

export interface ApplySuggestionsOptions {
  nowIso: string;
  /**
   * question 类建议 targetId 为空 = 新建 Question，但新建行必须挂在某场面经下；
   * 这个映射只有调用方（D14 面板）知道当前上下文，由它提供。返回 null = 跳过写入。
   */
  resolveQuestionExperienceId?: (suggestion: AISuggestion) => string | null;
}

export interface ApplySuggestionsResult {
  undo: AiUndo;
  /** 实际写入的建议条数（目标已消失的建议只置状态、不写目标表） */
  applied: number;
}

/**
 * 接受勾选的建议：单次遍历，目标写入与状态翻转发生在同一个 mutate 里。
 * 不在本函数内 pushUndo —— 撤销栈是 App 的职责，这里只交出快照。
 */
export function applySuggestions(
  db: DB,
  ids: ReadonlySet<string>,
  opts: ApplySuggestionsOptions,
): ApplySuggestionsResult {
  const undo: AiUndo = { suggestions: [], targets: [] };
  let applied = 0;

  for (const suggestion of db.aiSuggestions) {
    if (!ids.has(suggestion.id) || suggestion.status !== 'pending') continue;
    undo.suggestions.push({ ...suggestion });
    suggestion.status = 'accepted';
    suggestion.decidedAt = opts.nowIso;

    const target = writeTarget(db, suggestion, opts);
    if (target) {
      undo.targets.push(target);
      applied += 1;
    }
  }
  return { undo, applied };
}

/** 按 targetType 把建议值写进目标表，返回撤销所需的差异记录 */
function writeTarget(
  db: DB,
  suggestion: AISuggestion,
  opts: ApplySuggestionsOptions,
): AiUndoTarget | null {
  const nowIso = opts.nowIso;
  switch (suggestion.targetType) {
    case 'question': {
      if (suggestion.targetId) {
        // 追加到既有题：按 fieldPath 改字段（text / myAnswer）
        const question = db.questions.find((item) => item.id === suggestion.targetId);
        if (!question) return null;
        const prev = (question as unknown as Record<string, unknown>)[suggestion.fieldPath];
        (question as unknown as Record<string, unknown>)[suggestion.fieldPath] = suggestion.content;
        question.updatedAt = nowIso;
        return {
          table: 'questions',
          id: question.id,
          field: suggestion.fieldPath,
          prevValue: typeof prev === 'string' ? prev : undefined,
          rowExisted: true,
        };
      }
      // 新建题：targetId 为空，接受时才落 Question 行
      const experienceId = opts.resolveQuestionExperienceId?.(suggestion) ?? null;
      if (!experienceId) return null;
      const meta: AISuggestionMeta = suggestion.meta ?? {};
      const row: Question = {
        id: uid('q'),
        experienceId,
        // R-AI-11：类别/我的回答随建议的 meta 落行（已过窄校验，非法值到不了这里）
        category: meta.category ?? null,
        difficulty: 2,
        text: suggestion.fieldPath === 'myAnswer' ? '' : suggestion.content,
        ...(suggestion.fieldPath === 'myAnswer' ? { myAnswer: suggestion.content } : {}),
        ...(meta.myAnswer && suggestion.fieldPath !== 'myAnswer' ? { myAnswer: meta.myAnswer } : {}),
        mastery: 0,
        tags: [],
        reviewCount: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      db.questions.push(row);
      return { table: 'questions', id: row.id, field: '', prevValue: undefined, rowExisted: false, createdRow: row };
    }
    case 'application_note': {
      // 话术草稿落成一条 memo 时间线；targetId 必须是投递 id
      if (!suggestion.targetId) return null;
      const note: Note = {
        id: uid('n'),
        applicationId: suggestion.targetId,
        type: 'memo',
        content: suggestion.content,
        auto: false,
        touchedAt: nowIso,
      };
      db.notes.push(note);
      return { table: 'notes', id: note.id, field: '', prevValue: undefined, rowExisted: false, createdRow: note };
    }
    case 'staging_field': {
      // 写回暂存行的 parsed 字段；AI 永远只碰 staging，不碰 applications
      if (!suggestion.targetId) return null;
      const item = db.staging.find((entry) => entry.id === suggestion.targetId);
      if (!item) return null;
      const parsed = item.parsed as unknown as Record<string, unknown>;
      const prev = parsed[suggestion.fieldPath];
      parsed[suggestion.fieldPath] = suggestion.content;
      /**
       * AI 补出公司名后，这一行就不再是「没解析出来」了 —— 放开成 unmapped，
       * 用户才能用行内的「归到某个状态」把它落成投递。reason 卡在 unparsed 的话，
       * 这条补全等于白做（resolveStaged 会拒绝没有公司名的归位，也会拒绝 unparsed 行）。
       * 只在**确实补上了公司名**时放开，避免把一条空壳行伪装成可归位的记录。
       */
      const prevReason =
        item.reason === 'unparsed' && suggestion.fieldPath === 'companyName' && suggestion.content.trim()
          ? item.reason
          : undefined;
      if (prevReason) item.reason = 'unmapped';
      return {
        table: 'staging',
        id: item.id,
        field: suggestion.fieldPath,
        prevValue: typeof prev === 'string' ? prev : undefined,
        rowExisted: true,
        ...(prevReason ? { prevReason } : {}),
      };
    }
    case 'resume_field': {
      // v0.9 / T07：写回简历**草稿**（db.resumes 的 content），绝不碰冻结版本 ——
      // 「投出去的那一版」必须字节级不变，测试里有显式断言。
      if (!suggestion.targetId) return null;
      const resume = db.resumes.find((item) => item.id === suggestion.targetId && !resumeGone(item));
      if (!resume) return null;
      const located = resumeItemOf(resume, suggestion.fieldPath);
      // 目标段落已被删掉 → 只翻建议状态（applied 不计），UI 层提示「目标段落已不存在」
      if (!located) return null;
      const meta = FIELD_META[located.key as keyof typeof FIELD_META];
      if (meta?.type === 'rich_bullets') {
        // 富文本字段：改写结果是整段文字，按行拆回 bullets（cleanBullets 语义与表单一致）
        const prevBullets = located.item.bullets;
        located.item.bullets = suggestion.content
          .split('\n')
          .map((line) => line.replace(/^[\s\-*•\d.、)）]+/, '').trim())
          .filter((line) => line.length > 0);
        resume.updatedAt = nowIso;
        return {
          table: 'resumes',
          id: resume.id,
          field: suggestion.fieldPath,
          prevValue: prevBullets?.join('\n'),
          rowExisted: true,
        };
      }
      const prev = located.item.fields[located.key];
      located.item.fields[located.key] = suggestion.content;
      resume.updatedAt = nowIso;
      return {
        table: 'resumes',
        id: resume.id,
        field: suggestion.fieldPath,
        prevValue: typeof prev === 'string' ? prev : undefined,
        rowExisted: true,
      };
    }
    default:
      return null;
  }
}

/* ------------------------------ 拒绝 ------------------------------ */

/** 批量拒绝：只翻状态，不写目标表。返回实际处理的条数 */
export function rejectSuggestions(db: DB, ids: ReadonlySet<string>, nowIso: string): number {
  let count = 0;
  for (const suggestion of db.aiSuggestions) {
    if (!ids.has(suggestion.id) || suggestion.status !== 'pending') continue;
    suggestion.status = 'rejected';
    suggestion.decidedAt = nowIso;
    count += 1;
  }
  return count;
}

/* ------------------------------ 撤销 ------------------------------ */

/**
 * ⌘Z 整体回退一次「接受建议」：
 * 目标行/字段恢复原值（新建行整行移除）+ 建议状态回 pending。
 * 与「⌘Z 只回退状态变更、用户手写内容不丢」的哲学一致 ——
 * 这里回退的正是用户**确认过的** AI 写入，不存在误伤手写内容。
 */
export function revertAi(db: DB, undo: AiUndo): void {
  // ① R-AI-11：先按 createdExperiences 整行移除新建的面经壳
  //（连带它的题目由下面 targets 的既有 questions 分支逐条移除 —— A-16 分工）
  for (const experienceId of undo.createdExperiences ?? []) {
    db.experiences = db.experiences.filter((item) => item.id !== experienceId);
  }
  // ② 建议状态恢复（按原值覆盖，连 decidedAt 一起抹掉）
  for (const original of undo.suggestions) {
    const current = db.aiSuggestions.find((item) => item.id === original.id);
    if (!current) continue;
    current.status = 'pending' as AISuggestionStatus;
    delete current.decidedAt;
  }
  // 目标写入倒序回退：同一行被两条建议改过时，先撤后写的
  for (let index = undo.targets.length - 1; index >= 0; index -= 1) {
    const target = undo.targets[index];
    if (!target.rowExisted) {
      if (target.table === 'questions') {
        db.questions = db.questions.filter((item) => item.id !== target.id);
      } else if (target.table === 'notes') {
        db.notes = db.notes.filter((item) => item.id !== target.id);
      } else if (target.table === 'staging') {
        db.staging = db.staging.filter((item) => item.id !== target.id);
      }
      // resumes 没有「新建行」形态（AI 只改字段，不建简历）——防御到这里就够了
      continue;
    }
    if (target.table === 'experiences') {
      // R-AI-11 补录路径：还原已有面经的 overallNote 原值（rowExisted 恒 true）。
      // 新建路径下这个壳已被 ① 删掉 —— find 不到就跳过，不要复活它。
      const experience = db.experiences.find((item) => item.id === target.id);
      if (!experience) continue;
      if (target.prevValue === undefined) delete experience.overallNote;
      else experience.overallNote = target.prevValue;
    } else if (target.table === 'staging') {
      const item = db.staging.find((entry) => entry.id === target.id);
      if (!item) continue;
      const parsed = item.parsed as unknown as Record<string, unknown>;
      if (target.prevValue === undefined) delete parsed[target.field];
      else parsed[target.field] = target.prevValue;
      // D17：补出公司名时放开的 reason 也要收回，否则暂存区状态与内容不一致
      if (target.prevReason) item.reason = target.prevReason;
    } else if (target.table === 'resumes') {
      // v0.9 / T07：简历草稿写回的回退。富文本字段撤销时把整段拆回 bullets，
      // 与写入路径互为镜像 —— 只回退一半的话，⌘Z 之后表单和纸就对不上了。
      const resume = db.resumes.find((item) => item.id === target.id);
      if (!resume) continue;
      const located = resumeItemOf(resume, target.field);
      if (!located) continue;
      const meta = FIELD_META[located.key as keyof typeof FIELD_META];
      if (meta?.type === 'rich_bullets') {
        if (target.prevValue === undefined) delete located.item.bullets;
        else located.item.bullets = target.prevValue.split('\n').filter((line) => line.length > 0);
      } else if (target.prevValue === undefined) {
        delete located.item.fields[located.key];
      } else {
        located.item.fields[located.key] = target.prevValue;
      }
    } else if (target.table === 'questions') {
      const question = db.questions.find((item) => item.id === target.id);
      if (!question) continue;
      if (target.prevValue === undefined) delete (question as unknown as Record<string, unknown>)[target.field];
      else (question as unknown as Record<string, unknown>)[target.field] = target.prevValue;
    }
    // notes 表只有「新建行」一种写入形态，走上面的 rowExisted 分支
  }
}

/* ------------------------------ 清理 ------------------------------ */

export interface SweepSuggestionsResult {
  kept: AISuggestion[];
  removed: number;
}

/**
 * 过期清理：rejected/accepted 且 decidedAt（兜底 createdAt）超过保留天数 → 丢。
 * pending 永不清理 —— 还没被用户决策的建议丢了等于「AI 说过的话消失了」。
 */
export function sweepExpiredSuggestions(
  list: AISuggestion[],
  now: Date,
  days: number = SUGGESTION_RETENTION_DAYS,
): SweepSuggestionsResult {
  const cutoff = now.getTime() - days * DAY_MS;
  const kept: AISuggestion[] = [];
  let removed = 0;
  for (const suggestion of list) {
    if (suggestion.status === 'pending') {
      kept.push(suggestion);
      continue;
    }
    const decidedMs = Date.parse(suggestion.decidedAt ?? suggestion.createdAt);
    if (Number.isNaN(decidedMs) || decidedMs > cutoff) {
      kept.push(suggestion);
      continue;
    }
    removed += 1;
  }
  return { kept, removed };
}
