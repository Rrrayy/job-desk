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
 */
export function capReports(rows: AIReport[], limit = AI_REPORT_LIMIT): AIReport[] {
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
  return kept;
}
