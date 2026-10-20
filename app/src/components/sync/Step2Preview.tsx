/**
 * ② 预览差异：五类计数（和必须等于识别条数）+ 差异表 + 解析失败清单。
 * 解析失败的条目**必须**显示出来（PRD §B.9 P0：不许静默丢）。
 */

import type { MergePlan, PlannedRow } from '../../lib/sync/types';
import { fieldLabel, rowSummaryText } from '../../lib/sync/engine';
import { STATUS_LABEL } from '../../lib/rules';
import { KindBadge, ConfidenceBadge, BlockedHint } from './badges';

export function Step2Preview({ plan }: { plan: MergePlan }) {
  const { counts } = plan;

  return (
    <section className="sync__step">
      <div className="sync__step-head">
        <h3 className="sync__step-title">② 预览差异</h3>
        <span className="sync__hint">识别 {plan.parsedCount} 条</span>
      </div>

      <div className="sync__counts">
        <span className="sync__count sync__count--new">新增 {counts.new}</span>
        <span className="sync__count sync__count--update">更新 {counts.update}</span>
        <span className="sync__count sync__count--unchanged">无变化 {counts.unchanged}</span>
        <span className="sync__count sync__count--conflict">冲突 {counts.conflict}</span>
        <span className="sync__count sync__count--staged">待归类 {counts.staged}</span>
      </div>

      {plan.unparsed.length > 0 ? (
        <div className="notice notice--warn">
          <strong>{plan.unparsed.length} 条没解析出来（不会丢，会进「待归类」）</strong>
          <ul className="sync__unparsed">
            {plan.unparsed.slice(0, 8).map((item, index) => (
              <li key={`${item.reason}-${index}`}>
                <span className="sync__unparsed-reason">{item.reason}</span>
                <span className="sync__unparsed-snippet">{item.rawSnippet || '（空）'}</span>
              </li>
            ))}
          </ul>
          {plan.unparsed.length > 8 ? (
            <p className="muted">还有 {plan.unparsed.length - 8} 条，合并后在暂存区可以逐条处理。</p>
          ) : null}
        </div>
      ) : null}

      <div className="table-wrap sync__table-wrap">
        <table className="table sync__table">
          <thead>
            <tr>
              <th>公司 · 岗位</th>
              <th>判定</th>
              <th>本地 → 平台</th>
              <th>会写入</th>
            </tr>
          </thead>
          <tbody>
            {plan.rows.map((row) => (
              <tr key={row.key} className={`sync__row--${row.kind}`}>
                <td>
                  <div className="sync__company">
                    <span>{row.record.companyName}</span>
                    <ConfidenceBadge level={row.record.overall} />
                  </div>
                  <div className="sync__job">{row.record.jobTitle || '（无岗位名）'}</div>
                </td>
                <td>
                  <KindBadge kind={row.kind} />
                  {row.matchedBy ? <div className="sync__matched">按{matchedByText(row.matchedBy)}</div> : null}
                </td>
                <td>
                  <div className="sync__diff">{diffText(row)}</div>
                  {row.warnings.length > 0 ? (
                    <div className="sync__warn">{row.warnings[0]}</div>
                  ) : null}
                </td>
                <td>
                  <div className="sync__write">{writeText(row)}</div>
                  <BlockedHint row={row} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function matchedByText(matchedBy: NonNullable<PlannedRow['matchedBy']>): string {
  switch (matchedBy) {
    case 'externalId':
      return '平台 id 匹配';
    case 'matchKey':
      return '公司+岗位快照';
    case 'company+title':
      return '公司+岗位相似';
    default:
      return '公司名匹配';
  }
}

function diffText(row: PlannedRow): string {
  if (row.kind === 'new') {
    return row.mappedStatus ? `— → ${STATUS_LABEL[row.mappedStatus]}` : '—';
  }
  if (row.kind === 'conflict' && row.conflict) {
    return `${STATUS_LABEL[row.conflict.local]} → ${STATUS_LABEL[row.conflict.platform]}`;
  }
  const statusChange = row.changes.find((change) => change.field === 'status');
  if (statusChange?.from && statusChange.to) {
    return `${STATUS_LABEL[statusChange.from as keyof typeof STATUS_LABEL]} → ${
      STATUS_LABEL[statusChange.to as keyof typeof STATUS_LABEL]
    }`;
  }
  if (row.changes.length === 0) return rowSummaryText(row);
  return row.changes
    .map((change) => `${fieldLabel(change.field)}${change.to ? `：${shortValue(change.to)}` : ''}`)
    .join('、');
}

function shortValue(value: string): string {
  const status = value as keyof typeof STATUS_LABEL;
  if (STATUS_LABEL[status]) return STATUS_LABEL[status];
  return value.length > 14 ? `${value.slice(0, 14)}…` : value;
}

function writeText(row: PlannedRow): string {
  if (row.kind === 'unchanged') return '仅记一次同步时间';
  if (row.kind === 'staged') return '不写入 → 暂存';
  if (row.kind === 'conflict') return row.defaultChecked ? '按你的选择覆盖' : '不写入';
  if (row.kind === 'new') return '整条新建';
  if (row.changes.length === 0) return '—';
  return row.changes.map((change) => fieldLabel(change.field)).join('、');
}
