/**
 * AIReport 生命周期单测（v0.9 / T07，ARCH §1.5 报告档）。
 *
 * 盯三条线：
 * 1. parseReport：summary / next_steps 拼进 content（报告上没有独立字段可读），
 *    非法 verdict 的维度整条丢 —— 一个维度胡说不能毁掉整份报告；
 * 2. scoreOf：分数在代码侧等权合成（strong=1 / partial=0.5 / gap=0），
 *    not_found 不计分母，全 not_found → undefined（卡上显示「材料不足」而不是 0 分）；
 * 3. capReports：每 target 最近 3 份 + 全库 200 份双闸，保留集**保序**
 *    （导出 → 导入往返逐字节相等的前提）。
 */

import { describe, expect, it } from 'vitest';
import { capReports, capReportsWithDrop, createReport, parseReport, reportsOfTarget, reportQuotaOf, scoreOf } from './reports';
import type { AIReport, AIReportDimension } from '../types';
import { AI_REPORT_LIMIT } from '../types';

const NOW = '2026-10-21T10:00:00.000Z';

function dim(partial: Partial<AIReportDimension> & { verdict: AIReportDimension['verdict'] }): AIReportDimension {
  return { key: 'k', label: '维度', ...partial };
}

describe('reports · parseReport', () => {
  it('summary 与 next_steps 拼进 content，且不落独立字段（§8 裁决）', () => {
    const result = parseReport(
      JSON.stringify({
        summary: '总体匹配良好',
        next_steps: ['补一个量化结果', '对齐 JD 关键词'],
        content: '正文',
        dimensions: [{ key: 'stack', label: '技术栈', verdict: 'gap' }],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('总体匹配良好');
    expect(result.content).toContain('- 补一个量化结果');
    expect(result.content).toContain('- 对齐 JD 关键词');
    expect(result.content).toContain('正文');
    expect(Object.keys(result)).not.toContain('summary');
    expect(Object.keys(result)).not.toContain('next_steps');
    expect(result.dimensions).toHaveLength(1);
  });

  it('非法 verdict 的维度整条丢弃，合法的照常保留', () => {
    const result = parseReport(
      JSON.stringify({
        content: '报告',
        dimensions: [
          { key: 'a', verdict: 'strong_match' },
          { key: 'b', verdict: '满分' },
          { key: 'c', verdict: 'gap' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dimensions?.map((entry) => entry.key)).toEqual(['a', 'c']);
  });

  it('非 JSON / 空内容 → ok:false + 人话，零写入', () => {
    expect(parseReport('这不是 JSON').ok).toBe(false);
    expect(parseReport(JSON.stringify({ summary: '', next_steps: [], content: '' })).ok).toBe(false);
  });

  it('{content,dimensions} 形状也接受；证据原句截 300 字', () => {
    const result = parseReport(
      JSON.stringify({
        content: '只有正文',
        dimensions: [{ key: 'a', verdict: 'gap', evidenceFromResume: '长'.repeat(500) }],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dimensions?.[0].evidenceFromResume).toHaveLength(300);
  });
});

describe('reports · scoreOf（本地合成分）', () => {
  it('strong=100 / gap=0，等权平均：[strong, gap] → 50', () => {
    expect(scoreOf([dim({ verdict: 'strong_match' }), dim({ verdict: 'gap' })])).toBe(50);
  });

  it('partial 记 0.5：[strong, partial, gap] → 50', () => {
    expect(scoreOf([dim({ verdict: 'strong_match' }), dim({ verdict: 'partial_match' }), dim({ verdict: 'gap' })])).toBe(50);
  });

  it('not_found 不计入分母：[strong, not_found] → 100 而不是 50', () => {
    expect(scoreOf([dim({ verdict: 'strong_match' }), dim({ verdict: 'not_found' })])).toBe(100);
  });

  it('全是 not_found（或没有维度）→ undefined：显示「材料不足」而不是 0 分', () => {
    expect(scoreOf([dim({ verdict: 'not_found' })])).toBeUndefined();
    expect(scoreOf(undefined)).toBeUndefined();
  });
});

describe('reports · createReport / capReports', () => {
  it('createReport：scoreLocal 在代码侧算好，id 以 rep_ 开头；没传 model 就没有 model 键', () => {
    const report = createReport({
      pluginId: 'builtin:d19-diag',
      targetType: 'resume_diagnosis',
      targetId: 'res-1',
      content: '报告',
      dimensions: [dim({ verdict: 'partial_match' })],
      createdAt: NOW,
    });
    expect(report.id.startsWith('rep_')).toBe(true);
    expect(report.scoreLocal).toBe(50);
    expect('model' in report).toBe(false);
  });

  it('每 target 只留最近 3 份，保留集保序（旧顺序不重排）', () => {
    const rows: AIReport[] = Array.from({ length: 4 }, (_, i) => ({
      id: `rep-${i}`,
      pluginId: 'builtin:d19-diag',
      targetType: 'resume_diagnosis',
      targetId: 'res-1',
      content: '#',
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
    }));
    const kept = capReports(rows);
    expect(kept.map((row) => row.id)).toEqual(['rep-1', 'rep-2', 'rep-3']);
  });

  it(`全库总闸 ${AI_REPORT_LIMIT} 份：每靶 3 份 × 70 个 target = 210 → 摘最旧 10 份`, () => {
    const rows: AIReport[] = [];
    for (let target = 0; target < 70; target += 1) {
      for (let seq = 0; seq < 3; seq += 1) {
        rows.push({
          id: `rep-${target}-${seq}`,
          pluginId: 'builtin:d19-diag',
          targetType: 'resume_diagnosis',
          targetId: `res-${target}`,
          content: '#',
          createdAt: new Date(Date.UTC(2026, 9, 1, target, seq)).toISOString(),
        });
      }
    }
    const kept = capReports(rows);
    expect(kept).toHaveLength(AI_REPORT_LIMIT);
    // 保序：原数组里最旧的 10 份（rep-0-* 到 rep-3-0）被摘掉，首个保留的是 rep-3-1
    expect(kept[0].id).toBe('rep-3-1');
    expect(kept[kept.length - 1].id).toBe('rep-69-2');
  });

  it('没超任何闸 → 每一行都保留且顺序不变', () => {
    const rows: AIReport[] = [
      { id: 'a', pluginId: 'p', targetType: 'resume_diagnosis', targetId: 'r1', content: '#', createdAt: NOW },
      { id: 'b', pluginId: 'p', targetType: 'application_analysis', targetId: 'app-1', content: '#', createdAt: NOW },
    ];
    expect(capReports(rows).map((row) => row.id)).toEqual(['a', 'b']);
  });
});

describe('reports · capReportsWithDrop（v0.9.1 / B-10 告知侧）', () => {
  const reportOf = (id: string, targetId: string, minute: number): AIReport => ({
    id,
    pluginId: 'builtin:d19-diag',
    targetType: 'resume_diagnosis',
    targetId,
    content: '#',
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString(),
  });

  it('★ 第 4 份进来时 droppedIds 精确指出被顶掉的是**最早那一份**', () => {
    const rows = [
      reportOf('rep-0', 'res-1', 0),
      reportOf('rep-1', 'res-1', 1),
      reportOf('rep-2', 'res-1', 2),
      reportOf('rep-3', 'res-1', 3),
    ];
    const result = capReportsWithDrop(rows);
    expect(result.droppedIds).toEqual(['rep-0']);
    expect(result.kept.map((row) => row.id)).toEqual(['rep-1', 'rep-2', 'rep-3']);
    // 与旧签名完全一致：kept 就是 capReports 的返回
    expect(result.kept).toEqual(capReports(rows));
  });

  it('没超闸时 droppedIds 为空（不能「总是丢一份」也能通过）', () => {
    const rows = [reportOf('rep-0', 'res-1', 0), reportOf('rep-1', 'res-2', 1)];
    const result = capReportsWithDrop(rows);
    expect(result.droppedIds).toEqual([]);
    expect(result.kept).toHaveLength(2);
  });

  it('只丢**同一个 target** 的最旧一份，别的 target 一份都不能少', () => {
    const rows = [
      reportOf('a-0', 'res-1', 0),
      reportOf('b-0', 'res-2', 1),
      reportOf('a-1', 'res-1', 2),
      reportOf('a-2', 'res-1', 3),
      reportOf('a-3', 'res-1', 4),
    ];
    const result = capReportsWithDrop(rows);
    expect(result.droppedIds).toEqual(['a-0']);
    expect(result.kept.some((row) => row.id === 'b-0')).toBe(true);
  });

  it('全库总闸：droppedIds 数量与摘掉的份数一致（200 份上限）', () => {
    const rows: AIReport[] = [];
    for (let target = 0; target < 70; target += 1) {
      for (let seq = 0; seq < 3; seq += 1) rows.push(reportOf(`r-${target}-${seq}`, `res-${target}`, target * 3 + seq));
    }
    const result = capReportsWithDrop(rows);
    expect(result.kept).toHaveLength(AI_REPORT_LIMIT);
    expect(result.droppedIds).toHaveLength(rows.length - AI_REPORT_LIMIT);
    // 保留集 + 丢弃集 = 输入集，一份不多一份不少（重建库时不能凭空多出报告）
    expect(result.kept.length + result.droppedIds.length).toBe(rows.length);
  });
});

describe('reports · reportsOfTarget / reportQuotaOf', () => {
  const row = (id: string, targetId: string, minute: number, targetType: AIReport['targetType'] = 'resume_diagnosis'): AIReport => ({
    id,
    pluginId: 'p',
    targetType,
    targetId,
    content: '#',
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString(),
  });

  it('reportsOfTarget：只取这个目标、最新在前、最多 3 份', () => {
    const rows = [
      row('r1', 'res-1', 1),
      row('r2', 'res-1', 2),
      row('r3', 'res-1', 3),
      row('other', 'res-2', 4),
      row('app', 'res-1', 5, 'application_analysis'),
    ];
    const list = reportsOfTarget(rows, 'resume_diagnosis', 'res-1');
    expect(list.map((report) => report.id)).toEqual(['r3', 'r2', 'r1']);
  });

  it('reportsOfTarget：同一 createdAt 时用原下标兜底，两次调用顺序一致', () => {
    const rows = [row('x', 'res-1', 1), row('y', 'res-1', 1)];
    expect(reportsOfTarget(rows, 'resume_diagnosis', 'res-1').map((r) => r.id)).toEqual(
      reportsOfTarget(rows, 'resume_diagnosis', 'res-1').map((r) => r.id),
    );
  });

  it('reportQuotaOf 三档：正常 / 将满（距上限 10 份）/ 已满', () => {
    expect(reportQuotaOf([])).toEqual({ used: 0, limit: AI_REPORT_LIMIT, full: false, nearlyFull: false });
    const nearly = Array.from({ length: AI_REPORT_LIMIT - 10 }, (_, i) => row(`n${i}`, `r${i}`, i));
    expect(reportQuotaOf(nearly).nearlyFull).toBe(true);
    expect(reportQuotaOf(nearly).full).toBe(false);
    const full = Array.from({ length: AI_REPORT_LIMIT }, (_, i) => row(`f${i}`, `r${i}`, i));
    expect(reportQuotaOf(full).full).toBe(true);
    expect(reportQuotaOf(full).used).toBe(AI_REPORT_LIMIT);
  });
});
