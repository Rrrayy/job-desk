/**
 * AIReport 生命周期纯函数（v0.9 / T07，ARCH §1.5 报告档）。
 *
 * 报告与建议的三点不同，决定了它是独立一档：
 * 1. **只读产出**：报告不写用户任何数据，不需要撤销 —— 用户怕的不是它改了什么，
 *    而是它「看起来像权威结论」，所以卡上必须有「本地合成，仅供参考」。
 * 2. **合成分在代码侧算**（`scoreOf`）：模型的 verdict 只有 4 个值，分数是本地
 *    等权合成的，不是模型打的 —— 名字里带 Local 就是这个意思。
 * 3. **上限双闸**：同一 target 只留最近 3 份（重复分析覆盖旧的），全库总数 200
 *    （复用 T01 的 AI_REPORT_LIMIT 口径）。
 *
 * ★ 报告上没有独立的 verdict / targetLabel / summary 字段 —— summary 与
 *   next_steps 在解析时就拼进 `content`，显示侧不许读不存在的键（§8 裁决）。
 */

import type { AIVerdict, AIReport, AIReportDimension } from '../types';
import { AI_REPORT_LIMIT } from '../types';
import { uid } from '../lib/util';
import { extractJson, isRecord } from './scenarios';

/** 同一 target 保留的报告份数（PRD 验收 23：连分析 4 次只留 3 份） */
export const REPORTS_PER_TARGET = 3;

/** AIReport.content 上限（types.ts 的字段注释口径） */
const CONTENT_CHARS = 8000;
/** 维度证据原句的截断长度（证据是「定位用」的，不是「复读用」的） */
const EVIDENCE_CHARS = 300;

const VALID_VERDICTS: readonly AIVerdict[] = ['strong_match', 'partial_match', 'gap', 'not_found'];

export type ParsedReport =
  | { ok: true; content: string; dimensions?: AIReportDimension[] }
  | { ok: false; error: string };

/**
 * 模型输出 → 报告载荷。
 * 接受 `{summary, next_steps, dimensions}` 与 `{content, dimensions}` 两种形状；
 * summary / next_steps **拼进 content**（「下一步」是叙述性内容，不落独立字段）。
 * 非法 verdict 的维度整条丢弃，其余照常 —— 一个维度胡说不能毁掉整份报告。
 */
export function parseReport(raw: string): ParsedReport {
  const payload = extractJson(raw);
  if (!isRecord(payload)) {
    return { ok: false, error: '模型返回的不是约定的 JSON（{content,dimensions}）—— 这次没有生成报告' };
  }
  const summary = typeof payload.summary === 'string' ? payload.summary.trim() : '';
  const steps = Array.isArray(payload.next_steps)
    ? payload.next_steps.filter((step): step is string => typeof step === 'string' && step.trim().length > 0)
    : [];
  const body = typeof payload.content === 'string' ? payload.content.trim() : '';
  const content = [summary, ...steps.map((step) => `- ${step.trim()}`), body]
    .filter((part) => part.length > 0)
    .join('\n')
    .slice(0, CONTENT_CHARS);
  if (!content) {
    return { ok: false, error: '模型返回了空内容 —— 这次没有生成报告，可以重试' };
  }
  const dims = Array.isArray(payload.dimensions) ? payload.dimensions : [];
  const dimensions: AIReportDimension[] = [];
  for (const entry of dims) {
    if (!isRecord(entry)) continue;
    const verdict = typeof entry.verdict === 'string' ? entry.verdict : '';
    if (!(VALID_VERDICTS as readonly string[]).includes(verdict)) continue;
    const evidenceFromResume = typeof entry.evidenceFromResume === 'string' ? entry.evidenceFromResume.trim() : '';
    const evidenceFromJd = typeof entry.evidenceFromJd === 'string' ? entry.evidenceFromJd.trim() : '';
    const gapDescription = typeof entry.gapDescription === 'string' ? entry.gapDescription.trim() : '';
    dimensions.push({
      key: typeof entry.key === 'string' ? entry.key.trim().slice(0, 50) : '',
      label: typeof entry.label === 'string' ? entry.label.trim().slice(0, 60) : '',
      verdict: verdict as AIVerdict,
      ...(evidenceFromResume ? { evidenceFromResume: evidenceFromResume.slice(0, EVIDENCE_CHARS) } : {}),
      ...(evidenceFromJd ? { evidenceFromJd: evidenceFromJd.slice(0, EVIDENCE_CHARS) } : {}),
      ...(gapDescription ? { gapDescription: gapDescription.slice(0, EVIDENCE_CHARS) } : {}),
    });
  }
  return { ok: true, content, ...(dimensions.length > 0 ? { dimensions } : {}) };
}

/**
 * 本地合成分（0–100 等权）：strong=1 / partial=0.5 / gap=0。
 * ★ not_found 不计入分母 —— 它是「材料里没提到」，不是「不匹配」；
 * 全是 not_found（或没有维度）时返回 undefined，卡上显示「材料不足」而不是 0 分。
 */
export function scoreOf(dimensions: AIReportDimension[] | undefined): number | undefined {
  const scored = (dimensions ?? []).filter((dimension) => dimension.verdict !== 'not_found');
  if (scored.length === 0) return undefined;
  const sum = scored.reduce(
    (acc, dimension) => acc + (dimension.verdict === 'strong_match' ? 1 : dimension.verdict === 'partial_match' ? 0.5 : 0),
    0,
  );
  return Math.round((sum / scored.length) * 100);
}

/** 组装一条报告行（scoreLocal 在代码侧算好，模型没打过分数） */
export function createReport(input: {
  pluginId: string;
  targetType: AIReport['targetType'];
  targetId: string;
  content: string;
  dimensions?: AIReportDimension[];
  model?: string;
  createdAt: string;
}): AIReport {
  return {
    id: uid('rep'),
    pluginId: input.pluginId,
    targetType: input.targetType,
    targetId: input.targetId,
    content: input.content,
    scoreLocal: scoreOf(input.dimensions),
    ...(input.dimensions && input.dimensions.length > 0 ? { dimensions: input.dimensions } : {}),
    ...(input.model ? { model: input.model } : {}),
    createdAt: input.createdAt,
  };
}

/**
 * 报告上限（每 target 最近 3 份 + 全库 200 份），返回**保序**的保留集 ——
 * 否则「导出 → 导入」往返会因为一次重排而不再逐字节相等。
 * 全库 200 的算法与 `trash.ts` 的 `capAiReports` 同口径；就地实现是为了避免
 * trash ↔ reports 循环导入（trash 在启动 sweep 里调用本函数）。
 *
 * @param rows 全库报告
 * @param limit 全库上限
 * @returns 保序的保留集（`capReportsWithDrop().kept`）
 */
export function capReports(rows: AIReport[], limit = AI_REPORT_LIMIT): AIReport[] {
  return capReportsWithDrop(rows, limit).kept;
}

/** `capReports` 的完整结果：留下了谁、**扔了谁** */
export interface ReportDrop {
  /** 保留集（保序） */
  kept: AIReport[];
  /** 被丢弃的报告 id（v0.9.1 新增：告知侧要知道「丢的是哪一份」） */
  droppedIds: string[];
}

/**
 * 报告上限，同时报出**被丢弃的 id**。
 *
 * 为什么必须有这个版本（v0.9.1 / B-10）：旧签名只返回保留集，调用方想知道
 * 「刚才那份报告有没有顶掉一份」，只能比前后长度 —— 长度相等时无法区分
 * 「没超上限」与「超了但扔的是别人」，断言也只能写 `before.length - after.length === 1`，
 * 不知道扔了哪份等于没测。有了 `droppedIds`，「告知用户丢了哪一份」才是可实现的。
 *
 * @param rows 全库报告
 * @param limit 全库上限（默认 `AI_REPORT_LIMIT`）
 * @returns 保留集 + 被丢弃的 id 列表
 */
export function capReportsWithDrop(rows: AIReport[], limit = AI_REPORT_LIMIT): ReportDrop {
  const indexed = rows.map((row, index) => ({ row, index, at: Date.parse(row.createdAt) || 0 }));
  const sorted = [...indexed].sort((a, b) => b.at - a.at || b.index - a.index);
  const perTarget = new Map<string, number>();
  const keep = new Set<number>();
  for (const entry of sorted) {
    const used = perTarget.get(entry.row.targetId) ?? 0;
    if (used < REPORTS_PER_TARGET) {
      perTarget.set(entry.row.targetId, used + 1);
      keep.add(entry.index);
    }
  }
  let kept = indexed.filter((entry) => keep.has(entry.index)).map((entry) => entry.row);
  if (kept.length > limit) {
    // 总闸：同样保序摘最旧（与 trash.capAiReports 同算法）
    const keepIds = new Set(
      [...kept]
        .map((row) => ({ row, at: Date.parse(row.createdAt) || 0 }))
        .sort((a, b) => b.at - a.at)
        .slice(0, limit)
        .map((entry) => entry.row.id),
    );
    kept = kept.filter((row) => keepIds.has(row.id));
  }
  const keptIds = new Set(kept.map((row) => row.id));
  const droppedIds = rows.filter((row) => !keptIds.has(row.id)).map((row) => row.id);
  return { kept, droppedIds };
}

/* ------------------------------ 报告质量自检（v0.10 / L2-7） ------------------------------ */

/**
 * 维度的整体形态。模型有三种典型的「偷懒」：
 * - 全 strong_match：没真读材料，顺着 JD 都说匹配；
 * - 全 gap：只说要求高，没对照简历；
 * - 全 not_found：材料确实没给（这时最诚实的做法是提示用户补简历）。
 *
 * 前两种要在卡片上明说「这次结论可能不可靠」，第三种要说「没材料，不是你不匹配」。
 * 不阻断、不重算分数 —— 只是不让一个看起来很权威的分数悄悄骗人。
 */
export type VerdictPattern = 'all_strong' | 'all_gap' | 'all_not_found' | 'none';

/**
 * 判定维度形态。`not_found` 不计入「全 gap」：它表达的是「材料没提到」，
 * 与「明确不匹配」是两件事（`scoreOf` 也把 not_found 排除在分母外，口径一致）。
 */
export function verdictPatternOf(dimensions: AIReportDimension[] | undefined): VerdictPattern {
  const list = dimensions ?? [];
  if (list.length === 0) return 'none';
  if (list.every((dimension) => dimension.verdict === 'not_found')) return 'all_not_found';
  const scored = list.filter((dimension) => dimension.verdict !== 'not_found');
  if (scored.length === 0) return 'all_not_found';
  if (scored.every((dimension) => dimension.verdict === 'strong_match')) return 'all_strong';
  if (scored.every((dimension) => dimension.verdict === 'gap')) return 'all_gap';
  return 'none';
}

/** 形态 → 给用户看的一句提醒（null = 不需要提醒） */
export function verdictWarningOf(dimensions: AIReportDimension[] | undefined): string | null {
  const pattern = verdictPatternOf(dimensions);
  if (pattern === 'all_strong') {
    return '所有维度都判为「强匹配」—— 模型可能没有真正对照材料，建议抽查两条证据原句。';
  }
  if (pattern === 'all_gap') {
    return '所有维度都判为「有差距」—— 可能是简历模块选少了，或目标岗位与本简历方向不一致。';
  }
  if (pattern === 'all_not_found') {
    return '所有维度都是「材料未提及」—— 这不是「你不匹配」，而是没提供可对照的简历内容。';
  }
  return null;
}

/** verdict 的中文说法（报告卡与 Markdown 导出共用一份，避免两处文案漂移） */
export const VERDICT_TEXT: Record<AIVerdict, string> = {
  strong_match: '强匹配',
  partial_match: '部分匹配',
  gap: '短板',
  not_found: '材料未提及',
};

/** Markdown 表格里不能出现裸的竖线与换行 */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/**
 * 报告 → Markdown（v0.10 / L3-7）。
 *
 * 为什么要有导出：报告是「看完就该拿去改简历」的东西，只能留在应用里
 * 等于把结论锁在一个标签页里。导出的是纯文本，进任何笔记/文档都能用。
 *
 * 分数那句必须带上「本地合成」：导出的文件脱离了应用上下文，
 * 读者只会看到一个 82，不会知道它不是模型打的分。
 */
export function reportToMarkdown(report: AIReport): string {
  const title = report.targetType === 'resume_diagnosis' ? '简历诊断报告' : '投递竞争力分析';
  const lines: string[] = [`# ${title}`, ''];
  lines.push(`- 生成时间：${report.createdAt}`);
  if (report.model) lines.push(`- 模型：${report.model}`);
  lines.push(
    `- 匹配分：${report.scoreLocal === undefined ? '材料不足（没有可计分的维度）' : `${report.scoreLocal}（本地按维度等权合成，仅供参考）`}`,
  );
  const dimensions = report.dimensions ?? [];
  if (dimensions.length > 0) {
    lines.push('', '## 维度对照', '', '| 维度 | 判定 | 简历依据 | JD 依据 | 差在哪 |', '| --- | --- | --- | --- | --- |');
    for (const dimension of dimensions) {
      lines.push(
        `| ${cell(dimension.label || dimension.key || '维度')} | ${VERDICT_TEXT[dimension.verdict]} | ${cell(
          dimension.evidenceFromResume ?? '',
        )} | ${cell(dimension.evidenceFromJd ?? '')} | ${cell(dimension.gapDescription ?? '')} |`,
      );
    }
  }
  lines.push('', '## 正文', '', report.content, '');
  return lines.join('\n');
}

/* ------------------------------ 报告历史与配额（v0.9.1 / R-AI-10） ------------------------------ */

/**
 * 取某个 target 的报告，**最新的在前**。
 *
 * 排序键是 `createdAt` 字符串降序（ISO 8601 字典序 = 时间序，不必解析成毫秒）；
 * 相同时刻用下标兜底，保证同一份数据每次都排出同一个顺序（否则「第 2/3 份」
 * 会在两次渲染之间跳来跳去）。
 *
 * @param rows 全库报告
 * @param targetType 'resume_diagnosis' | 'application_diagnosis'
 * @param targetId Resume.id / Application.id
 * @returns 最新的在前，最多 `REPORTS_PER_TARGET` 份
 */
export function reportsOfTarget(
  rows: AIReport[],
  targetType: AIReport['targetType'],
  targetId: string,
): AIReport[] {
  return rows
    .map((report, index) => ({ report, index }))
    .filter(({ report }) => report.targetType === targetType && report.targetId === targetId)
    .sort((a, b) => {
      if (a.report.createdAt !== b.report.createdAt) return a.report.createdAt < b.report.createdAt ? 1 : -1;
      return a.index - b.index;
    })
    .map(({ report }) => report)
    .slice(0, REPORTS_PER_TARGET);
}

/** 报告配额的当前状态（UI 三种口径：正常 / 将满 / 已满） */
export interface ReportQuota {
  used: number;
  limit: number;
  /** 全库已满 —— 再生成会静默丢一份，所以入口要置灰 */
  full: boolean;
  /** ≥190 就开始提示（离上限 10 份时提醒，别等到撞墙） */
  nearlyFull: boolean;
}

/**
 * 全库报告配额。报告上限是一道「代码替用户扔东西」的闸，v0.9.1 把它从
 * 「静默丢」改成「提前告知 + 用户显式删」（架构 B-10），这个函数就是告知侧的读数。
 *
 * @param rows 全库报告
 * @param limit 全库上限（默认 `AI_REPORT_LIMIT = 200`）
 * @returns 当前份数与三档状态
 */
export function reportQuotaOf(rows: AIReport[], limit = AI_REPORT_LIMIT): ReportQuota {
  const used = rows.length;
  return { used, limit, full: used >= limit, nearlyFull: used >= limit - 10 };
}
