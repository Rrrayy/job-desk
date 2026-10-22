/**
 * AI 报告卡（v0.9 / T07）—— 一张两用：简历诊断与投递分析共用同一份渲染口径。
 *
 * §8 裁决的显示纪律（改这个文件前先读）：
 * - 顶部 = `scoreLocal`（**代码侧**等权合成分）+「本地合成，仅供参考」——
 *   分数不是模型打的，这句不写，用户会把 82 分当成模型的客观评价；
 * - 中部 = `dimensions` 逐行渲染 verdict（4 值）+ 简历/JD 证据对照；
 * - 正文 = `content` 摘要（summary 与 next_steps 在解析时就拼在里面了）。
 * 报告上**没有**独立的 verdict / targetLabel / summary 字段可取 —— 读不存在的键
 * 就是静默渲染空白，比报错更糟。
 */

import type { AIReport, AIVerdict } from '../../types';

const VERDICT_LABEL: Record<AIVerdict, string> = {
  strong_match: '强匹配',
  partial_match: '部分匹配',
  gap: '短板',
  not_found: '材料未提及',
};

export function ReportCard({ report }: { report: AIReport }): JSX.Element {
  return (
    <section className="report-card" aria-label="AI 报告">
      <header className="report-card__head">
        <span className="report-card__score">
          {report.scoreLocal === undefined ? '材料不足' : `${report.scoreLocal} 分`}
        </span>
        <span className="report-card__note">本地合成，仅供参考</span>
        {report.model ? <span className="report-card__model">{report.model}</span> : null}
      </header>

      {(report.dimensions ?? []).length > 0 ? (
        <ul className="report-card__dims">
          {(report.dimensions ?? []).map((dimension, index) => (
            <li key={`${dimension.key}-${index}`} className={`report-card__dim report-card__dim--${dimension.verdict}`}>
              <span className="report-card__dim-head">
                {dimension.label || dimension.key || '维度'} · {VERDICT_LABEL[dimension.verdict]}
              </span>
              {dimension.evidenceFromResume ? (
                <p className="report-card__evidence">简历：{dimension.evidenceFromResume}</p>
              ) : null}
              {dimension.evidenceFromJd ? <p className="report-card__evidence">JD：{dimension.evidenceFromJd}</p> : null}
              {dimension.gapDescription ? <p className="report-card__gap">{dimension.gapDescription}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="field__hint">模型没有给出维度判定 —— 只有一段总评。</p>
      )}

      <details className="report-card__body">
        <summary>展开报告正文</summary>
        <pre>{report.content}</pre>
      </details>
    </section>
  );
}
