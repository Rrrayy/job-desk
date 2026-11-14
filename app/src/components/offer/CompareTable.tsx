/**
 * 模块一 · 并排对比表（OFF-6）。
 *
 * 两个刻意的取舍：
 * 1. **候选集是勾选的，不是排好的** —— 工具不替你决定「该对比哪几个」；
 * 2. 每一维的贡献都要摊开写出来（`3 ×30 = 18.0`），只给总分就是黑箱替你排序。
 */

import type { OfferCandidate, CompareRow } from '../../lib/offer/compare';
import type { OfferScoreKey } from '../../types';
import { cx } from '../../lib/util';
import { CLS } from '../../lib/classTokens';

export interface CompareTableProps {
  candidates: OfferCandidate[];
  selectedIds: string[];
  rows: CompareRow[];
  /** 被 8 列上限挤掉的条数（0 = 没挤掉） */
  overflow: number;
  onToggle: (id: string) => void;
}

export function CompareTable({ candidates, selectedIds, rows, overflow, onToggle }: CompareTableProps) {
  const selected = selectedIds
    .map((id) => candidates.find((item) => item.app.id === id))
    .filter((item): item is OfferCandidate => Boolean(item));

  return (
    <div className="cmp" data-testid="compare-table">
      <div className="cmp__pick">
        <span className={CLS.d}>勾选要对比的 Offer（最多 8 个）</span>
        <div className="cmp__chips">
          {candidates.map((item) => {
            const company = item.company ? item.company.shortName || item.company.name : '未知公司';
            const active = selectedIds.includes(item.app.id);
            return (
              <button
                key={item.app.id}
                type="button"
                className={cx(CLS.v, active && 'is-active')}
                onClick={() => onToggle(item.app.id)}
                aria-pressed={active}
                data-testid={`cmp-pick-${item.app.id}`}
              >
                {company} · {item.app.jobTitle}
              </button>
            );
          })}
        </div>
        {overflow > 0 ? (
          <p className={CLS.c}>还有 {overflow} 个 Offer 没进表 —— 勾掉一个再看它。</p>
        ) : null}
      </div>

      {selected.length === 0 ? (
        <p className={cx(CLS.d, 'cmp__empty')}>先勾两个以上，并排看才成立。</p>
      ) : (
        <div className="cmp__scroll">
          <table className="cmp__table">
            <thead>
              <tr>
                <th scope="col">项目</th>
                {selected.map((item) => (
                  <th key={item.app.id} scope="col">
                    <span className="cmp__head-company">
                      {item.company ? item.company.shortName || item.company.name : '未知公司'}
                    </span>
                    <span className="cmp__head-job">{item.app.jobTitle}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className={row.key === 'total' ? 'cmp__row--total' : undefined}>
                  <th scope="row">{row.label}</th>
                  {row.cells.map((cell, index) => (
                    <td
                      key={`${row.key}-${index}`}
                      className={cell.tone ? `cmp__cell--${cell.tone}` : undefined}
                    >
                      {cell.text}
                      {cell.note ? <span className="cmp__note">{cell.note}</span> : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** 维度权重文案（给 WeightPanel 的滑块标签用） */
export const WEIGHT_DIM_LABEL: Record<OfferScoreKey, string> = {
  salary: '薪资',
  growth: '成长',
  city: '城市',
  wlb: 'WLB',
};
