/**
 * 版本菜单（PRD §8 / Q12）—— 冻结版本的唯一操作面板。
 *
 * 为什么单独一个组件而不是塞进 ResumeEditor 的工具条：
 * 版本这一块有 8 个动作、两种二次确认、一个回收站折叠区，还有「已 28/30」这类
 * 只在特定时刻出现的灰字。混进编辑器会让那个组件的 render 变成一锅粥，
 * 而这块逻辑恰好是「用户数据最不可逆」的地方 —— 它值得自己的文件、自己的测试。
 *
 * 三条写在代码里的产品口径：
 * 1. **二次确认只给真正会伤人的两个动作**：删除（可能被投递引用）、以此版本为草稿
 *    （会覆盖当前草稿）。改个名字、设个主版本还要弹窗，只会让人学会无脑点「确定」。
 * 2. **删除被引用的版本时，第一句话必须说「投递记录不会消失」**（A-12）：
 *    用户此刻最怕的不是版本没了，而是「我的投递是不是也没了」。
 * 3. **上限只提示不拦**：第 28 个起显示灰字，到 30 个还能存，第 31 个才由
 *    `saveVersion` 拒绝并给出原因（Q12）。提前拦住会让人以为程序坏了。
 */

import { useState } from 'react';
import type { AppApi } from '../../lib/api';
import type { Resume, ResumeVersion } from '../../types';
import { fmtDateTime } from '../../lib/date';
import { cx } from '../../lib/util';

export interface VersionMenuProps {
  api: AppApi;
  resume: Resume;
  /**
   * 存新版本前必须先落库（最后 400 ms 的输入还在防抖窗口里，A-07）。
   * 编辑器传 `useResumeDraft().flush`。
   */
  onBeforeSave: () => void;
}

export function VersionMenu({ api, resume, onBeforeSave }: VersionMenuProps) {
  const versions = api.resume.versionsOf(resume.id);
  const trashed = api.resume.trashedVersionsOf(resume.id);
  const primaryId = api.resume.primaryVersionId;

  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  /** 待确认「删除」的版本 id */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  /** 待确认「以此版本为草稿」的版本 id */
  const [confirmDraftId, setConfirmDraftId] = useState<string | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);

  const quotaHint = api.resume.quotaHint(resume.id);

  const save = (): void => {
    // 顺序不能反：先 flush（把编辑期的最后一段写进库），快照才是「屏幕上看到的那一版」
    onBeforeSave();
    const result = api.resume.saveVersion(resume.id, label);
    if (result.ok) {
      setLabel('');
      setError(null);
    } else {
      setError(result.reason);
    }
  };

  const startRename = (version: ResumeVersion): void => {
    setRenamingId(version.id);
    setRenameText(version.label);
    setConfirmDeleteId(null);
    setConfirmDraftId(null);
  };

  const commitRename = (): void => {
    if (renamingId) api.resume.renameVersion(renamingId, renameText);
    setRenamingId(null);
    setRenameText('');
  };

  return (
    <section className="ver-menu" aria-label="版本">
      <header className="ver-menu__head">
        <h3 className="ver-menu__title">版本</h3>
        <span className="ver-menu__count">
          {versions.length} 个
          {trashed.length > 0 ? ` · 回收站 ${trashed.length}` : ''}
        </span>
      </header>

      <div className="ver-menu__save">
        <input
          className="input input--compact"
          type="text"
          value={label}
          placeholder="新版本名（留空自动 v1、v2…）"
          aria-label="新版本名"
          onChange={(event) => {
            setLabel(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            save();
          }}
        />
        <button type="button" className="btn btn--small btn--primary" onClick={save}>
          存为新版本
        </button>
      </div>
      <p className="field__hint">
        存下来的版本是冻结快照：之后继续改草稿不会改到它；要改就用「以此版本为草稿」。
      </p>
      {quotaHint ? <p className="ver-menu__quota">{quotaHint}</p> : null}
      {error ? <p className="field__hint field__hint--danger">{error}</p> : null}

      {versions.length === 0 ? (
        <p className="ver-menu__empty">还没有版本。投出去之前先存一版，投递才绑得住「当时那份」。</p>
      ) : (
        <ul className="ver-list">
          {versions.map((version) => {
            const isPrimary = version.id === primaryId;
            const refs = api.resume.referencesOf(version.id);
            return (
              <li className={cx('ver-item', isPrimary && 'ver-item--primary')} key={version.id}>
                {renamingId === version.id ? (
                  <div className="ver-item__row">
                    <input
                      className="input input--compact"
                      type="text"
                      value={renameText}
                      aria-label="版本名"
                      autoFocus
                      onChange={(event) => setRenameText(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          commitRename();
                        }
                        if (event.key === 'Escape') setRenamingId(null);
                      }}
                    />
                    <button type="button" className="btn btn--tiny" onClick={commitRename}>
                      保存
                    </button>
                    <button type="button" className="btn btn--tiny btn--ghost" onClick={() => setRenamingId(null)}>
                      取消
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="ver-item__row">
                      <span className="ver-item__label">{version.label}</span>
                      {isPrimary ? <span className="ver-item__badge">主版本</span> : null}
                      <span className="ver-item__meta">{fmtDateTime(version.createdAt)}</span>
                    </div>
                    <div className="ver-item__acts">
                      <button
                        type="button"
                        className="btn btn--tiny"
                        onClick={() => {
                          setConfirmDraftId(version.id);
                          setConfirmDeleteId(null);
                        }}
                      >
                        以此版本为草稿
                      </button>
                      <button type="button" className="btn btn--tiny btn--ghost" onClick={() => startRename(version)}>
                        重命名
                      </button>
                      <button
                        type="button"
                        className="btn btn--tiny btn--ghost"
                        disabled={isPrimary}
                        title={isPrimary ? '已经是主版本' : '新建投递时默认绑定这一版'}
                        onClick={() => api.resume.setPrimary(version.id)}
                      >
                        设为主版本
                      </button>
                      <button
                        type="button"
                        className="btn btn--tiny btn--danger-ghost"
                        onClick={() => {
                          setConfirmDeleteId(version.id);
                          setConfirmDraftId(null);
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </>
                )}

                {confirmDraftId === version.id ? (
                  <div className="ver-item__confirm">
                    <p>
                      「{version.label}」的内容会复制成当前草稿 —— 当前草稿里没存版本的内容会丢，
                      已冻结的版本本身不变。
                    </p>
                    <div className="ver-item__acts">
                      <button
                        type="button"
                        className="btn btn--tiny btn--primary"
                        onClick={() => {
                          onBeforeSave();
                          api.resume.adoptAsDraft(version.id);
                          setConfirmDraftId(null);
                        }}
                      >
                        确认覆盖草稿
                      </button>
                      <button type="button" className="btn btn--tiny btn--ghost" onClick={() => setConfirmDraftId(null)}>
                        取消
                      </button>
                    </div>
                  </div>
                ) : null}

                {confirmDeleteId === version.id ? (
                  <div className="ver-item__confirm">
                    <p>
                      {/* A-12：这句话必须排第一 —— 用户此刻最怕的是「投递也跟着没了」 */}
                      投递记录会保留，绑定处显示「{version.label}（已删除）」。
                    </p>
                    <p className="field__hint">
                      {refs > 0
                        ? `有 ${refs} 条投递绑在这一版上；删除后它们不会丢，只是不再指向一个可查看的版本。`
                        : '没有投递绑在这一版上。删除后进回收站，30 天后自动清理。'}
                    </p>
                    <div className="ver-item__acts">
                      <button
                        type="button"
                        className="btn btn--tiny btn--danger-ghost"
                        onClick={() => {
                          api.resume.deleteVersion(version.id);
                          setConfirmDeleteId(null);
                        }}
                      >
                        确认删除
                      </button>
                      <button type="button" className="btn btn--tiny btn--ghost" onClick={() => setConfirmDeleteId(null)}>
                        取消
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {trashed.length > 0 ? (
        <div className="ver-trash">
          <button
            type="button"
            className="ver-trash__toggle"
            aria-expanded={trashOpen}
            onClick={() => setTrashOpen((open) => !open)}
          >
            {trashOpen ? '▾' : '▸'} 回收站（{trashed.length}）· 30 天后自动清理
          </button>
          {trashOpen ? (
            <ul className="ver-list ver-list--trash">
              {trashed.map((version) => (
                <li className="ver-item" key={version.id}>
                  <div className="ver-item__row">
                    <span className="ver-item__label">{version.label}</span>
                    <span className="ver-item__meta">删除于 {fmtDateTime(version.deletedAt ?? '')}</span>
                  </div>
                  <div className="ver-item__acts">
                    <button type="button" className="btn btn--tiny" onClick={() => api.resume.restoreVersion(version.id)}>
                      恢复
                    </button>
                    <button
                      type="button"
                      className="btn btn--tiny btn--danger-ghost"
                      onClick={() => api.resume.purgeVersion(version.id)}
                    >
                      永久删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
