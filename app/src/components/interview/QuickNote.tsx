/**
 * 快记面经：一行一题，Enter 连记。
 *
 * 关键路径（架构 §4.3）：面完当天从「今日」或详情抽屉点进来，90 秒记 5 题。
 * 所以这里只做四件事：带上公司/轮次、一行一题、**每行两个不必填的小下拉**（掌握度 / 分类）、
 * 点「记完了」按各自选择一次落库。
 *
 * v0.9 / T-QB ①：以前落库全是「不会 + 未分类」，用户没得选。现在下拉就地可改，
 * 默认仍是「不会 / 未分类」—— 默认值不变 = 快记的最短路径没变长。
 *
 * 落库口径：**记完了 / 关闭时一次写入**（`api.addQuestions(id, items)`）。
 * 所以每行的选择始终是本地状态，改起来没有写库往返。
 */

import { useMemo, useState } from 'react';
import type { AppApi, NewQuestionInput } from '../../lib/api';
import type { Mastery, QuestionCategory } from '../../types';
import { todayISO } from '../../lib/date';
import { deriveInitialNextReviewAt } from '../../lib/interview';
import { MasteryCategoryPicks } from './MasteryCategoryPicks';

/** 快记列表里的一行：题干 + 两个还没落库的选择 */
interface QuickLine {
  text: string;
  mastery: Mastery;
  category: QuestionCategory | null;
}

export function QuickNote({ api, onClose }: { api: AppApi; onClose: () => void }) {
  const ctx = api.quickNote ?? {};
  const [companyName, setCompanyName] = useState(ctx.companyName ?? '');
  const [jobTitle, setJobTitle] = useState(ctx.jobTitle ?? '');
  const [round, setRound] = useState(ctx.round ? String(ctx.round) : '');
  const [interviewDate, setInterviewDate] = useState(ctx.interviewDate ?? todayISO(api.now));
  const [draft, setDraft] = useState('');
  const [lines, setLines] = useState<QuickLine[]>([]);
  const [experienceId, setExperienceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nextReview = useMemo(
    () => deriveInitialNextReviewAt(interviewDate, api.now.toISOString()),
    [interviewDate, api.now],
  );

  const total = lines.length + (draft.trim() ? 1 : 0);

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

  /** Enter：只进本地列表，不落库（落库统一在「记完了」） */
  const commitDraft = (): void => {
    const text = draft.trim();
    if (!text) return;
    if (!companyName.trim()) {
      setError('先填公司名 —— 只填这一个也能存');
      return;
    }
    setError(null);
    setLines((prev) => [...prev, { text, mastery: 0, category: null }]);
    setDraft('');
  };

  const patchLine = (index: number, patch: { mastery?: Mastery; category?: QuestionCategory | null }): void => {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  };

  /**
   * 落库并关闭。返回 false = 没写成功、浮层留着让用户改（关掉就丢了，不干这事）。
   * 末尾还没按 Enter 的内容也一起收下（按默认值），不让用户白打一遍。
   */
  const flushAndClose = (): void => {
    const items: NewQuestionInput[] = lines.map((line) => ({
      text: line.text,
      mastery: line.mastery,
      category: line.category,
    }));
    const tail = draft.trim();
    if (tail) items.push({ text: tail });
    if (items.length === 0) {
      onClose();
      return;
    }
    const id = ensureExperience();
    if (!id) return;
    const written = api.addQuestions(id, items);
    if (written === 0) {
      setError('这些题都没存进去（可能是重复或超长），改一下再试');
      return;
    }
    const skipped = items.length - written;
    api.toast(
      skipped > 0
        ? `已记 ${written} 题 · ${skipped} 题重复或超长已跳过 · ${nextReview} 提醒复习`
        : `已记 ${written} 题 · ${nextReview} 提醒复习`,
    );
    onClose();
  };

  return (
    <div className="quick-note-overlay" onClick={flushAndClose}>
      <section className="quick-note" onClick={(event) => event.stopPropagation()}>
        <header className="quick-note__head">
          <h2 className="quick-note__title">记面经</h2>
          <button type="button" className="icon-btn" onClick={flushAndClose} title="关闭（Esc）" aria-label="关闭">
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
              <li key={index} className="quick-note__item">
                <span className="quick-note__index">{index + 1}</span>
                <span className="quick-note__text">{line.text}</span>
                <MasteryCategoryPicks
                  mastery={line.mastery}
                  category={line.category}
                  onChange={(patch) => patchLine(index, patch)}
                  labelPrefix={`第 ${index + 1} 题`}
                />
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
            <button type="button" className="btn btn--small btn--primary" onClick={flushAndClose}>
              记完了（{total} 题）
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
