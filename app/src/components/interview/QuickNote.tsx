/**
 * 快记面经：一行一题，Enter 连记。
 *
 * 关键路径（架构 §4.3）：面完当天从「今日」或详情抽屉点进来，90 秒记 5 题。
 * 所以这里**只做三件事**：带上公司/轮次、一行一题、记完告诉用户「几天后提醒复习」。
 * 分类 / 难度 / 我的回答都留到「面经编辑器」里补 —— 快记时多一个必填项就是多一个放弃的理由。
 */

import { useMemo, useState } from 'react';
import type { AppApi } from '../../lib/api';
import { todayISO } from '../../lib/date';
import { deriveInitialNextReviewAt } from '../../lib/interview';

export function QuickNote({ api, onClose }: { api: AppApi; onClose: () => void }) {
  const ctx = api.quickNote ?? {};
  const [companyName, setCompanyName] = useState(ctx.companyName ?? '');
  const [jobTitle, setJobTitle] = useState(ctx.jobTitle ?? '');
  const [round, setRound] = useState(ctx.round ? String(ctx.round) : '');
  const [interviewDate, setInterviewDate] = useState(ctx.interviewDate ?? todayISO(api.now));
  const [draft, setDraft] = useState('');
  const [lines, setLines] = useState<string[]>([]);
  const [experienceId, setExperienceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nextReview = useMemo(
    () => deriveInitialNextReviewAt(interviewDate, api.now.toISOString()),
    [interviewDate, api.now],
  );

  const ensureExperience = (): string | null => {
    if (experienceId) return experienceId;
    if (!companyName.trim()) {
      setError('先填公司名 —— 只填这一个也能存');
      return null;
    }
    const id = api.addExperience({
      applicationId: ctx.applicationId ?? null,
      companyName: companyName.trim(),
      jobTitle: jobTitle.trim() || undefined,
      round: round ? Number(round) : null,
      interviewDate,
      result: 'pending',
      source: 'self',
    });
    setExperienceId(id);
    return id;
  };

  const commitDraft = (): void => {
    const text = draft.trim();
    if (!text) return;
    const id = ensureExperience();
    if (!id) return;
    const written = api.addQuestions(id, [text]);
    if (written === 0) {
      setError('这道题没存进去（可能是重复或超长），换个说法再试');
      return;
    }
    setError(null);
    setLines((prev) => [...prev, text]);
    setDraft('');
  };

  const handleClose = (): void => {
    // 输入框里还有没按 Enter 的内容 —— 替用户收下，不让他白打一遍
    if (draft.trim()) {
      const id = ensureExperience();
      if (id) {
        api.addQuestions(id, [draft.trim()]);
        setLines((prev) => [...prev, draft.trim()]);
      }
    }
    const count = lines.length + (draft.trim() ? 1 : 0);
    if (count > 0) {
      api.toast(`已记 ${count} 题 · ${nextReview} 提醒复习`);
    }
    onClose();
  };

  return (
    <div className="quick-note-overlay" onClick={handleClose}>
      <section className="quick-note" onClick={(event) => event.stopPropagation()}>
        <header className="quick-note__head">
          <h2 className="quick-note__title">记面经</h2>
          <button type="button" className="icon-btn" onClick={handleClose} title="关闭（Esc）" aria-label="关闭">
            ✕
          </button>
        </header>

        <div className="quick-note__meta">
          <label className="field field--narrow">
            <span className="field__label">公司</span>
            <input
              className="input"
              value={companyName}
              placeholder="字节跳动"
              onChange={(event) => setCompanyName(event.target.value)}
            />
          </label>
          <label className="field field--narrow">
            <span className="field__label">岗位</span>
            <input
              className="input"
              value={jobTitle}
              placeholder="抖音前端（可空）"
              onChange={(event) => setJobTitle(event.target.value)}
            />
          </label>
          <label className="field field--tiny">
            <span className="field__label">轮次</span>
            <input
              className="input"
              type="number"
              min={1}
              value={round}
              placeholder="1"
              onChange={(event) => setRound(event.target.value)}
            />
          </label>
          <label className="field field--narrow">
            <span className="field__label">面试日期</span>
            <input
              className="input"
              type="date"
              value={interviewDate}
              onChange={(event) => setInterviewDate(event.target.value)}
            />
          </label>
        </div>

        <p className="quick-note__hint">
          一行一题，敲 <kbd>Enter</kbd> 就记下、光标不动。记不起来的先记个关键词也行 ——
          <strong>不记就永远想不起来了</strong>。
        </p>

        <div className="quick-note__body">
          <ul className="quick-note__list">
            {lines.map((line, index) => (
              <li key={`${index}-${line.slice(0, 8)}`} className="quick-note__item">
                <span className="quick-note__index">{index + 1}</span>
                <span className="quick-note__text">{line}</span>
              </li>
            ))}
          </ul>

          <input
            className="input quick-note__input"
            value={draft}
            placeholder={lines.length === 0 ? '例：手写 Promise.all' : '下一题…'}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitDraft();
              }
            }}
          />

          {error ? <div className="notice notice--danger">{error}</div> : null}
        </div>

        <footer className="quick-note__foot">
          <span className="muted">
            记完会有 {nextReview} 的复习提醒（+1 / +3 / +7 天里最近的一个）
          </span>
          <div className="quick-note__actions">
            <button type="button" className="btn btn--small" onClick={commitDraft} disabled={!draft.trim()}>
              ＋ 再加一题
            </button>
            <button type="button" className="btn btn--small btn--primary" onClick={handleClose}>
              记完了（{lines.length + (draft.trim() ? 1 : 0)} 题）
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
