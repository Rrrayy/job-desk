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
import { capReports, createReport, parseReport, scoreOf } from './reports';
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
