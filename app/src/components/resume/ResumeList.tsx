/**
 * 简历列表（PRD §8）—— 简历页的「一级」。
 *
 * 显示什么由用户的一级任务决定：**我现在有几份简历、哪份是主投、最近动过没有**。
 * 所以一行里只有四件事：名字、模板、版本数、更新时间；其余全是次要动作。
 *
 * 三条产品口径：
 * 1. **新建要带模板**：空模板会渲染出一张「什么板块都没有」的纸（T02 的
 *    「切模板绝不渲染空表单」是这个问题的另一半）。所以新建面板里先选模板再建。
 * 2. **复制不带版本历史**（PRD §8）：副本是一次都还没投过的材料，
 *    把 30 个历史版本搬过去，「这份简历有几个版本」从第一天起就是假的。
 * 3. **删除是软删**：进回收站、30 天后清；删掉的简历不该在列表里占位，
 *    但也不该让人一按就永久消失。回收站折叠区在列表底部，内联恢复。
 */

import { useState } from 'react';
import type { AppApi } from '../../lib/api';
import type { Resume, TemplateId } from '../../types';
import { TEMPLATE_LIST } from '../../resume/templates';
import { fmtDateTime } from '../../lib/date';
import { cx } from '../../lib/util';

export function ResumeList({ api }: { api: AppApi }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState<TemplateId>('tech-single');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [trashOpen, setTrashOpen] = useState(false);

  const list = api.resume.list;
  const trashed = api.resume.trashed;

  const submitCreate = (): void => {
    const id = api.resume.create({ name, templateId });
    setName('');
    setCreating(false);
    api.resume.open(id);
  };

  const rows = list.slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  return (
    <div className="resume-home">
      <header className="resume-home__head">
        <div>
          <h2 className="resume-home__title">简历</h2>
          <p className="field__hint">
            草稿可以一直改；投出去的那一版要「存为新版本」冻结下来，投递才绑得住「当时那份」。
          </p>
        </div>
        <button type="button" className="btn btn--primary" onClick={() => setCreating((open) => !open)}>
          ＋ 新建简历
        </button>
      </header>

      {creating ? (
        <div className="resume-home__new">
          <label className="field">
            <span className="field__label">名字</span>
            <input
              className="input"
              type="text"
              value={name}
              placeholder="例：前端开发 - 主投"
              aria-label="简历名字"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitCreate();
                }
              }}
            />
          </label>
          <label className="field">
            <span className="field__label">模板</span>
            <select
              className="input"
              value={templateId}
              aria-label="模板"
              onChange={(event) => setTemplateId(event.target.value as TemplateId)}
            >
              {TEMPLATE_LIST.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}（{template.targetDirection}）
                </option>
              ))}
            </select>
          </label>
          <div className="resume-home__new-acts">
            <button type="button" className="btn btn--primary" onClick={submitCreate}>
              创建
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setCreating(false)}>
              取消
            </button>
          </div>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p className="resume-home__empty">
          还没有简历。先建一份 —— 模板随时能换，内容不会因为换模板而丢。
        </p>
      ) : (
        <ul className="resume-rows">
          {rows.map((resume) => (
            <ResumeRow
              key={resume.id}
              api={api}
              resume={resume}
              renaming={renamingId === resume.id}
              renameText={renameText}
              onRenameText={setRenameText}
              onStartRename={() => {
                setRenamingId(resume.id);
                setRenameText(resume.name);
              }}
              onEndRename={() => setRenamingId(null)}
            />
          ))}
        </ul>
      )}

      {trashed.length > 0 ? (
        <div className="resume-home__trash">
          <button
            type="button"
            className="res-trash__toggle"
            aria-expanded={trashOpen}
            onClick={() => setTrashOpen((open) => !open)}
          >
            {trashOpen ? '▾' : '▸'} 回收站（{trashed.length}）· 30 天后自动清理
          </button>
          {trashOpen ? (
            <ul className="resume-rows resume-rows--trash">
              {trashed.map((resume) => (
                <li className="resume-row resume-row--trash" key={resume.id}>
                  <div className="resume-row__main">
                    <span className="resume-row__name">{resume.name}</span>
                    <span className="resume-row__meta">删除于 {fmtDateTime(resume.deletedAt ?? '')}</span>
                  </div>
                  <div className="resume-row__acts">
                    <button type="button" className="btn btn--tiny" onClick={() => api.resume.restore(resume.id)}>
                      恢复
                    </button>
                    <button
                      type="button"
                      className="btn btn--tiny btn--danger-ghost"
                      onClick={() => api.resume.purge(resume.id)}
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
    </div>
  );
}

interface ResumeRowProps {
  api: AppApi;
  resume: Resume;
  renaming: boolean;
  renameText: string;
  onRenameText: (value: string) => void;
  onStartRename: () => void;
  onEndRename: () => void;
}

function ResumeRow(props: ResumeRowProps) {
  const { api, resume, renaming, renameText, onRenameText, onStartRename, onEndRename } = props;
  const versions = api.resume.versionsOf(resume.id);
  const template = TEMPLATE_LIST.find((item) => item.id === resume.templateId);
  const isPrimary = versions.some((version) => version.id === api.resume.primaryVersionId);

  return (
    <li className={cx('resume-row', isPrimary && 'resume-row--primary')}>
      {renaming ? (
        <div className="resume-row__main">
          <input
            className="input input--compact"
            type="text"
            value={renameText}
            aria-label="简历名字"
            autoFocus
            onChange={(event) => onRenameText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                api.resume.rename(resume.id, renameText);
                onEndRename();
              }
              if (event.key === 'Escape') onEndRename();
            }}
          />
          <div className="resume-row__acts">
            <button
              type="button"
              className="btn btn--tiny"
              onClick={() => {
                api.resume.rename(resume.id, renameText);
                onEndRename();
              }}
            >
              保存
            </button>
            <button type="button" className="btn btn--tiny btn--ghost" onClick={onEndRename}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="resume-row__main">
            <button type="button" className="resume-row__name" onClick={() => api.resume.open(resume.id)}>
              {resume.name}
            </button>
            <span className="resume-row__meta">
              {template?.name ?? resume.templateId} · {versions.length} 个版本 · 更新于{' '}
              {fmtDateTime(resume.updatedAt)}
            </span>
          </div>
          <div className="resume-row__acts">
            <button type="button" className="btn btn--tiny btn--primary" onClick={() => api.resume.open(resume.id)}>
              打开
            </button>
            <button type="button" className="btn btn--tiny btn--ghost" onClick={onStartRename}>
              重命名
            </button>
            <button
              type="button"
              className="btn btn--tiny btn--ghost"
              title="复制内容，不带版本历史"
              onClick={() => {
                const id = api.resume.duplicate(resume.id);
                if (id) api.resume.open(id);
              }}
            >
              复制
            </button>
            <button
              type="button"
              className="btn btn--tiny btn--danger-ghost"
              onClick={() => api.resume.softDelete(resume.id)}
            >
              删除
            </button>
          </div>
        </>
      )}
    </li>
  );
}
