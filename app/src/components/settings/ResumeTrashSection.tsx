/**
 * 设置 → 回收站里的「简历」子区（v0.9.1 / R-RES-10，架构 B-07 / B-08）。
 *
 * ## 为什么合并进「设置 → 回收站」，不独立成页
 *
 * 「删了的东西在哪找回来」是**一个**心智模型。两个入口会让用户忘了还有第二个。
 * 而且这里复用既有的 `.trash-row` 行组件与「再留 7 天 / 恢复 / 永久删除」三件套，
 * 只换图标与单位文案（「份」而不是「条」）—— 独立页面要 +4 KB（页壳 + 空态 + 快捷键），
 * 而设置区本来就是**兜底**，不是主路径（简历页内有内联恢复）。
 *
 * ## 为什么只列到「简历」这一层，不列版本树（B-08）
 *
 * `visibleResumeVersions` 已经确立：**简历软删 → 其下版本一并不可见**（靠父
 * `deletedAt` 推导，不逐条打标记）。所以恢复一份简历 = 恢复它下面全部版本。
 * 版本单独软删（简历还在）的情况，这里只在行下缩进显示计数「含 M 个已删版本」，
 * 真正的恢复入口在简历页的版本菜单里 —— 两棵树 = 两套软删语义，是 `trash.ts`
 * 头部明令禁止的方向。
 *
 * ## 数据从哪来
 *
 * `api.resume.trashed`（App 侧已经过滤好的软删简历）。不额外接一个 prop 是有意的：
 * `SettingsDrawer` 的 `trashed` prop 之所以单独传，是因为 `api.db` 是**摘掉回收站**
 * 的视图库；简历这边的同款视图库字段已经存在（`api.resume.trashed`），
 * 再串一层 prop 只是把同一份数据搬一次。
 */

import { useState } from 'react';
import type { AppApi } from '../../lib/api';
import { trashDaysLeft } from '../../lib/trash';
import { cx } from '../../lib/util';
import { CLS } from '../../lib/classTokens';
import { fmtDate } from '../../lib/date';

export interface ResumeTrashSectionProps {
  api: AppApi;
}

export function ResumeTrashSection({ api }: ResumeTrashSectionProps) {
  const trashed = api.resume.trashed;
  const [purgeTarget, setPurgeTarget] = useState<string | null>(null);
  const now = api.now;

  // 空的整段不渲染（与既有投递回收站同款处理）：没有已删简历时不该出现「简历（0 份）」
  if (trashed.length === 0) return null;

  return (
    <div className="resume-trash">
      <h4 className="resume-trash__title">简历（{trashed.length} 份）</h4>
      <p className={CLS.c}>
        删除的简历在这里留 30 天，恢复时它下面的版本一并回来。只想找回某一个版本，请到简历页的版本菜单。
      </p>
      <ul className="trash-list">
        {trashed.map((resume) => {
          const days = trashDaysLeft(resume, now);
          const urgent = days !== null && days <= 3;
          const deletedVersions = api.resume.trashedVersionsOf(resume.id).length;
          return (
            <li key={resume.id} className={cx('trash-row', urgent && 'trash-row--expiring')}>
              <div className="trash-row__main">
                <span className="trash-row__title">📄 {resume.name}</span>
                <span className={cx('trash-row__meta', urgent && 'trash-row__meta--warn')}>
                  {fmtDate(resume.deletedAt)} 删除 · {days === null ? '已到期' : `还剩 ${days} 天`}
                  {deletedVersions > 0 ? ` · 含 ${deletedVersions} 个已删版本` : ''}
                </span>
              </div>
              <div className={CLS.aV}>
                <button type="button" className={CLS.ap} onClick={() => api.resume.restore(resume.id)}>
                  恢复
                </button>
                <button type="button" className={CLS.h} onClick={() => api.resume.extendTrash(resume.id)}>
                  再留 7 天
                </button>
                {purgeTarget === resume.id ? (
                  <>
                    <button
                      type="button"
                      className={CLS.V}
                      onClick={() => {
                        api.resume.purge(resume.id);
                        setPurgeTarget(null);
                      }}
                    >
                      确认永久删除
                    </button>
                    <button type="button" className={CLS.h} onClick={() => setPurgeTarget(null)}>
                      取消
                    </button>
                  </>
                ) : (
                  <button type="button" className={CLS.x} onClick={() => setPurgeTarget(resume.id)}>
                    永久删除
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
