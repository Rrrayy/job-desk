/**
 * 导入冲突确认（v0.5 / D4）。
 *
 * 为什么需要这个面板：v0.4.1 的导入是「整库覆盖」，所以没有冲突这个概念 ——
 * 备份里是什么就是什么。改成增量合并之后，「同一条投递两边都有、值不一样」
 * 就必须停下来问用户，否则合并算法在替用户做判断。
 *
 * 三条硬规则：
 * 1. **默认保留本地**（不勾 = 不动）。这是与同步面板一致的语义，
 *    也是唯一安全的方向 —— 备份可能是旧的，本地一定是新的。
 * 2. 受保护字段（简历版本 / 优先级）即使勾了也对它无效，勾选框要显式说明。
 * 3. 这个组件**不算合并结果**，只把勾选集合交给上层重算（与 SyncDrawer 同一思路）。
 */

import type { ConflictRow, MergeCounts } from '../lib/merge';

export interface ImportConfirmProps {
  counts: MergeCounts;
  conflicts: ConflictRow[];
  /** 当前勾了「用备份覆盖」的本地投递 id */
  overwrite: ReadonlySet<string>;
  onToggle: (localId: string, next: boolean) => void;
  onToggleAll: (next: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ImportConfirm(props: ImportConfirmProps) {
  const { counts, conflicts, overwrite, onToggle, onToggleAll, onConfirm, onCancel } = props;
  const overwriteCount = overwrite.size;

  return (
    <div className="drawer-overlay" onClick={onCancel}>
      <aside
        className="drawer drawer--sync"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label="导入冲突确认"
      >
        <header className="drawer__head">
          <div className="drawer__title-wrap">
            <h2 className="drawer__title">导入前确认</h2>
            <p className="drawer__sub">
              备份里有 {counts.conflicts} 条和你现有的记录对不上（同公司 + 同岗位 + 同投递日期）。
              每一条都可以单独决定用哪边的值。
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onCancel} title="取消（Esc）" aria-label="取消">
            ✕
          </button>
        </header>

        <div className="drawer__body">
          <div className="import__summary">
            <span className="import__stat">
              新增 <strong>{counts.added}</strong> 条投递
            </span>
            {counts.addedCompanies > 0 ? (
              <span className="import__stat">
                新增 <strong>{counts.addedCompanies}</strong> 家公司
              </span>
            ) : null}
            {counts.addedInterviews > 0 ? (
              <span className="import__stat">
                <strong>{counts.addedInterviews}</strong> 场面试
              </span>
            ) : null}
            {counts.addedNotes > 0 ? (
              <span className="import__stat">
                <strong>{counts.addedNotes}</strong> 条沟通记录
              </span>
            ) : null}
            {counts.unchanged > 0 ? (
              <span className="import__stat import__stat--dim">
                完全重复 <strong>{counts.unchanged}</strong> 条（不动）
              </span>
            ) : null}
          </div>

          <div className="notice">
            新增的内容**一定会写入**。下面只处理「两边都有、但值不一样」的 {counts.conflicts} 条。
          </div>

          <div className="import__bulk">
            <span className="muted">
              默认全部<b>保留本地</b>；勾上才用备份的值覆盖。已勾 {overwriteCount} / {conflicts.length}
            </span>
            <span className="import__bulk-btns">
              <button
                type="button"
                className="btn btn--small"
                onClick={() => onToggleAll(true)}
                disabled={overwriteCount === conflicts.length}
              >
                全用备份
              </button>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => onToggleAll(false)}
                disabled={overwriteCount === 0}
              >
                全保留本地
              </button>
            </span>
          </div>

          <ul className="import__conflicts">
            {conflicts.map((row) => {
              const checked = overwrite.has(row.localId);
              const protectedDiffs = row.diffs.filter((diff) => diff.protected);
              return (
                <li key={row.localId} className={checked ? 'import__conflict import__conflict--on' : 'import__conflict'}>
                  <label className="import__conflict-head">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => onToggle(row.localId, event.target.checked)}
                    />
                    <span className="import__conflict-title">
                      <strong>{row.company}</strong>
                      <span className="import__conflict-job">{row.jobTitle || '（无岗位名）'}</span>
                    </span>
                    <span className="import__conflict-side">{checked ? '用备份覆盖' : '保留本地'}</span>
                  </label>

                  <table className="import__diff">
                    <thead>
                      <tr>
                        <th>字段</th>
                        <th>本地</th>
                        <th>备份</th>
                      </tr>
                    </thead>
                    <tbody>
                      {row.diffs.map((diff) => (
                        <tr key={diff.field} className={diff.protected ? 'import__diff-row--protected' : undefined}>
                          <th scope="row">{diff.label}</th>
                          <td className={checked && !diff.protected ? 'import__val--lost' : undefined}>{diff.local}</td>
                          <td className={checked && !diff.protected ? 'import__val--win' : undefined}>{diff.incoming}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {protectedDiffs.length > 0 ? (
                    <p className="import__conflict-note">
                      {protectedDiffs.map((diff) => diff.label).join('、')} 是你手改过的，无论选哪边都保留本地的值。
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>

        <footer className="sync__foot">
          <div className="sync__foot-left">
            <span className="muted">导入不会删掉任何现有记录</span>
          </div>
          <div className="sync__foot-right">
            <button type="button" className="btn btn--small" onClick={onCancel}>
              取消
            </button>
            <button type="button" className="btn btn--small btn--primary" onClick={onConfirm}>
              {overwriteCount > 0 ? `确认导入（${overwriteCount} 条用备份）` : '确认导入（全部保留本地）'}
            </button>
          </div>
        </footer>
      </aside>
    </div>
  );
}
