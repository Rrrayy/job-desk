// @vitest-environment jsdom
/**
 * ReportCard 组件测试（v0.9 / T07）。
 *
 * 盯 §8 裁决的显示纪律：
 * - 顶部合成分旁必须有「本地合成，仅供参考」—— 分数不是模型打的；
 * - scoreLocal undefined 显示「材料不足」，不显示 0 分；
 * - 维度逐行渲染 verdict 中文标签与简历/JD 证据；
 * - 报告上没有 summary / verdict 独立字段可读 —— 读不存在键就是静默空白。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReportCard } from './ReportCard';
import type { AIReport } from '../../types';

const NOW = '2026-10-21T10:00:00.000Z';

function report(overrides: Partial<AIReport> = {}): AIReport {
  return {
    id: 'rep-1',
    pluginId: 'builtin:d19-diag',
    targetType: 'resume_diagnosis',
    targetId: 'res-1',
    content: '# 总评\n- 下一步：补量化结果',
    scoreLocal: 67,
    dimensions: [
      {
        key: 'stack',
        label: '技术栈',
        verdict: 'gap',
        evidenceFromResume: '熟悉 React',
        evidenceFromJd: '要求熟悉 Rust',
        gapDescription: '缺少系统编程经验',
      },
      { key: 'exp', label: '项目经验', verdict: 'strong_match' },
      { key: 'edu', label: '学历', verdict: 'not_found' },
    ],
    createdAt: NOW,
    ...overrides,
  };
}

describe('ReportCard（一张两用：简历诊断 / 投递分析）', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(item: AIReport): void {
    root = createRoot(container);
    act(() => {
      root.render(<ReportCard report={item} />);
    });
  }

  it('合成分 + 「本地合成，仅供参考」+ 模型名', () => {
    render(report({ model: 'qwen2.5:7b' }));
    expect(container.textContent).toContain('67 分');
    expect(container.textContent).toContain('本地合成，仅供参考');
    expect(container.textContent).toContain('qwen2.5:7b');
  });

  it('scoreLocal undefined → 「材料不足」而不是 0 分', () => {
    render(report({ scoreLocal: undefined, dimensions: [{ key: 'a', label: '维度', verdict: 'not_found' }] }));
    expect(container.textContent).toContain('材料不足');
    expect(container.textContent).not.toContain('0 分');
  });

  it('维度逐行：verdict 中文标签 + 简历/JD 证据 + 短板描述', () => {
    render(report());
    expect(container.textContent).toContain('技术栈 · 短板');
    expect(container.textContent).toContain('简历：熟悉 React');
    expect(container.textContent).toContain('JD：要求熟悉 Rust');
    expect(container.textContent).toContain('缺少系统编程经验');
    expect(container.textContent).toContain('项目经验 · 强匹配');
    expect(container.textContent).toContain('学历 · 材料未提及');
  });

  it('正文摘要收在 details 里；没有维度时给一句提示而不是空白', () => {
    render(report({ dimensions: undefined }));
    const details = container.querySelector('details.report-card__body');
    expect(details?.textContent).toContain('下一步：补量化结果');
    expect(container.textContent).toContain('模型没有给出维度判定');
  });
});
