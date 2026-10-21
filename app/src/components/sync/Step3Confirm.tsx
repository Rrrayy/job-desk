/**
 * ③ 逐项确认：三个批量开关 + 逐行勾选 + 冲突行的明确选择。
 *
 * 硬规则（PRD §B.5 / 架构 §3.3）：
 * - 勾选状态**完全由 props 里的 row.checked 决定**，组件不推导、不改默认值；
 * - `unchanged` 行不可勾（它没有可写字段，勾了只会造成「我合了个寂寞」的误解）；
 * - 冲突行必须让用户看见「本地 vs 平台」，默认不勾。
 */

import type { MergePlan, PlannedRow } from '../../lib/sync/types';
import { rowSummaryText } from '../../lib/sync/engine';
import { ALL_STATUSES, STATUS_LABEL } from '../../lib/rules';
import type { Status } from '../../types';
import { KindBadge, ConfidenceBadge } from './badges';

export interface Step3ConfirmProps {
  plan: MergePlan;
  /** 用户改动某一行勾选 */
  onToggle: (key: string, checked: boolean) => void;
  /** 三个批量开关的结果（由 SyncDrawer 统一算，组件只负责按钮） */
  onCheckOnly: (kind: PlannedRow['kind']) => void;
  onUncheckAll: () => void;
  onCheckConflicts: () => void;
  /** v0.7.2：staged 行人工指定状态 → 行升级为新增写入，不进暂存区 */
  onManualStatus: (key: string, status: Status) => void;
}

const SELECTABLE: PlannedRow['kind'][] = ['new', 'update', 'conflict'];

export function Step3Confirm(props: Step3ConfirmProps) {
  const { plan, onToggle, onCheckOnly, onUncheckAll, onCheckConflicts, onManualStatus } = props;
  const checkedCount = plan.rows.filter((row) => isChecked(row)).length;
  const conflictCount = plan.rows.filter((row) => row.kind === 'conflict').length;

  return (
    <section className="sync__step">
      <div className="sync__step-head">
        <h3 className="sync__step-title">③ 逐项确认</h3>
        <span className="sync__hint">
          已勾选 <strong>{checkedCount}</strong> / 可写{' '}
          {plan.rows.filter((row) => SELECTABLE.includes(row.kind)).length}
        </span>
      </div>

      <div className="sync__bulk">
        <button type="button" className="btn btn--small" onClick={() => onCheckOnly('new')}>
          只勾新增（{plan.counts.new}）
        </button>
        <button type="button" className="btn btn--small" onClick={() => onCheckOnly('update')}>
          只勾更新（{plan.counts.update}）
        </button>
        <button
          type="button"
          className="btn btn--small btn--primary"
          onClick={onCheckConflicts}
          disabled={conflictCount === 0}
        >
          全勾冲突（{conflictCount}）
        </button>
        <button type="button" className="btn btn--small" onClick={onUncheckAll}>
          全不勾
        </button>
        <span className="muted sync__bulk-hint">默认勾选按「高置信度优先」，冲突默认不勾。</span>
      </div>

      <ul className="sync__confirm-list">
        {plan.rows.map((row) => {
          const selectable = row.kind !== 'unchanged';
          const checked = isChecked(row);
          return (
            <li key={row.key} className={`sync__confirm-item sync__row--${row.kind}`}>
              <label className="sync__confirm-check">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!selectable}
                  onChange={(event) => onToggle(row.key, event.target.checked)}
                />
                <span className="sync__confirm-main">
                  <span className="sync__confirm-company">
                    {row.record.companyName}
                    <ConfidenceBadge level={row.record.overall} />
                  </span>
                  <span className="sync__confirm-job">{row.record.jobTitle || '（无岗位名）'}</span>
                </span>
              </label>

              <div className="sync__confirm-body">
                <div className="sync__confirm-line">
                  <KindBadge kind={row.kind} />
                  <span className="sync__confirm-text">{rowSummaryText(row)}</span>
                </div>

                {row.kind === 'conflict' && row.conflict ? (
                  <div className="sync__conflict">
                    <span className="sync__conflict-side">
                      本地 <strong>{STATUS_LABEL[row.conflict.local]}</strong>
                    </span>
                    <span className="sync__conflict-arrow">→</span>
                    <span className="sync__conflict-side">
                      平台 <strong>{STATUS_LABEL[row.conflict.platform]}</strong>
                    </span>
                    {row.conflict.userEditedAt ? (
                      <span className="sync__conflict-note">
                        你 {isoDay(row.conflict.userEditedAt)} 手动改过
                      </span>
                    ) : null}
                    {row.kind === 'conflict' && !checked ? (
                      <span className="sync__conflict-note">不勾 = 保留你的判断，平台这条会进暂存区</span>
                    ) : null}
                  </div>
                ) : null}

                {row.kind === 'staged' ? (
                  <div className="sync__staged-note">
                    <div>这条没法自动归类（{reasonText(row)}），合并后会进暂存区逐条处理。</div>
                    <label className="sync__manual-status">
                      <span>人工指定状态（当场归类，按新增写入）：</span>
                      <select
                        className="select select--compact"
                        value=""
                        onChange={(event) => {
                          const value = event.target.value as Status;
                          if (value) onManualStatus(row.key, value);
                        }}
                      >
                        <option value="">选状态…</option>
                        {ALL_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {STATUS_LABEL[status]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : null}

                {row.manuallyResolved && row.mappedStatus ? (
                  <div className="sync__manual-status-done">
                    ✍️ 你手动指定状态：<strong>{STATUS_LABEL[row.mappedStatus]}</strong>
                    （按新增写入，不进暂存区；公司 / 岗位仍以解析结果为准）
                  </div>
                ) : null}

                {row.warnings.length > 0 ? (
                  <ul className="sync__warnings">
                    {row.warnings.map((warning, index) => (
                      <li key={`${row.key}-w-${index}`}>{warning}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      {checkedCount === 0 ? (
        <div className="notice notice--warn">
          当前一条都没勾。确认合并不会修改任何投递，但会把「待归类 / 冲突」的行放进暂存区。
        </div>
      ) : null}
    </section>
  );
}

/** `checked` 为 undefined 时退回引擎给的默认值（UI 绝不重新推导） */
function isChecked(row: PlannedRow): boolean {
  if (row.kind === 'unchanged') return false;
  return row.checked ?? row.defaultChecked;
}

function reasonText(row: PlannedRow): string {
  switch (row.stagedReason) {
    case 'unmapped':
      return '状态没认出来';
    case 'ambiguous':
      return `有 ${row.candidateAppIds?.length ?? 0} 条疑似同公司同岗位`;
    case 'conflict':
      return '与你的判断冲突';
    default:
      return '信息不全';
  }
}

function isoDay(iso: string): string {
  // ISO → 3/12（本地时区，与产品其他地方一致）
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}
