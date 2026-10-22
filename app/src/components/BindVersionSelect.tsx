/**
 * 绑定选择器（ARCH §4.0 T06）：投递编辑处选「当时投的是哪一版简历」。
 *
 * 三条 UI 口径：
 * 1. **候选只有冻结版本**（`candidateVersions`：活简历 × 活版本，按简历名分组可读性更好）；
 *    草稿不是版本，结构上就进不了候选 —— 「不允许绑草稿」不是靠 disabled 拦的，是靠不出。
 * 2. **悬空要诚实**：当前绑的版本被删后，下拉里保留一个 disabled 选项把
 *    「v3（已删除）」亮出来 —— 偷偷跳到「未绑定」会让用户以为记录丢了。
 * 3. **改绑留痕就摆在旁边**：最近 3 条 + 总次数，改绑发生在什么时候、
 *    从哪版到哪版（上一条就是旧值），一眼能对出来。
 *
 * F9 由 `bindResumeVersion`（纯函数层）保证：这里只调 api，不碰 notes/时间线。
 */

import { useMemo } from 'react';
import type { AppApi } from '../lib/api';
import type { Application } from '../types';
import { candidateVersions, resolveBoundVersion } from '../resume/bind';
import { fmtDateTime } from '../lib/date';
import { cx } from '../lib/util';

const STATE_TEXT: Record<string, string> = {
  bound: '',
  dangling: '版本已删除，投递记录保留',
  legacy: '旧数据的文本快照，绑定后按版本统计',
  none: '未绑定',
};

export function BindVersionSelect({ api, app }: { api: AppApi; app: Application }) {
  const db = api.db;
  const view = resolveBoundVersion(db, app);
  const candidates = useMemo(() => candidateVersions(db), [db]);

  const onBind = (value: string): void => {
    api.bindResumeVersion(app.id, value === 'none' ? null : value);
  };

  return (
    <div className="bind">
      <label className="field">
        <span className="field__label">简历版本</span>
        <select
          className={cx('input bind__select', view.state === 'dangling' && 'bind__select--dangling')}
          aria-label="绑定的简历版本"
          value={view.state === 'none' || view.state === 'legacy' ? 'none' : (view.versionId ?? 'none')}
          onChange={(event) => onBind(event.target.value)}
        >
          <option value="none">未绑定</option>
          {view.state === 'dangling' ? (
            <option value={view.versionId ?? 'none'} disabled>
              {view.label}（当前，已删除）
            </option>
          ) : null}
          {candidates.map((candidate) => (
            <option key={candidate.versionId} value={candidate.versionId}>
              {candidate.resumeName} · {candidate.label}
            </option>
          ))}
        </select>
      </label>
      {STATE_TEXT[view.state] ? <p className="field__hint bind__hint">{STATE_TEXT[view.state]}</p> : null}

      {(app.resumeBindLog ?? []).length > 0 ? (
        <details className="bind__log">
          <summary>改绑记录（{(app.resumeBindLog ?? []).length}）</summary>
          <ul>
            {(app.resumeBindLog ?? [])
              .slice()
              .reverse()
              .slice(0, 3)
              .map((entry, index) => (
                <li key={`${entry.at}-${index}`}>
                  {fmtDateTime(entry.at)} · {entry.label}
                </li>
              ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
