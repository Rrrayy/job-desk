/**
 * 复习卡片：一次一张，先回忆再翻面。
 *
 * 交互（PRD §E.3）：
 * - ← / → 上一张下一张，空格翻面（翻面不改变滚动位置，所以卡片内部单独滚动）；
 * - 标完掌握度立刻按新排序重排（列表数据来自 props，App 写库后自动重算）；
 * - 键盘事件绑定在 window 上，但输入框聚焦时不抢键。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Question } from '../../types';
import type { AppApi } from '../../lib/api';
import { CATEGORY_LABEL, MASTERY_LABEL } from '../../lib/interview';

export interface ReviewCardsProps {
  questions: Question[];
  api: AppApi;
  onExit: () => void;
}

export function ReviewCards({ questions, api, onExit }: ReviewCardsProps) {
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const safeIndex = Math.min(index, Math.max(questions.length - 1, 0));
  const current = questions[safeIndex];

  const go = (delta: number): void => {
    if (questions.length === 0) return;
    const next = (safeIndex + delta + questions.length) % questions.length;
    setIndex(next);
    setFlipped(false);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  };

  const mark = (mastery: 0 | 1 | 2): void => {
    if (!current) return;
    api.reviewQuestion(current.id, mastery);
    api.toast(`已标「${MASTERY_LABEL[mastery]}」，下次复习时间已重排`);
    setFlipped(false);
    if (questions.length > 1) go(1);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const tag = target ? target.tagName : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        go(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        go(1);
      } else if (event.key === ' ') {
        event.preventDefault();
        setFlipped((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const positionText = useMemo(
    () => (questions.length === 0 ? '0 / 0' : `${safeIndex + 1} / ${questions.length}`),
    [safeIndex, questions.length],
  );

  if (!current) {
    return (
      <div className="empty-block">
        <div className="empty-block__emoji">✅</div>
        <div className="empty-block__title">这个筛选下没有题</div>
        <p className="empty-block__text">换一个筛选条件，或者先去「＋ 记面经」记几道题。</p>
        <div className="empty-block__actions">
          <button type="button" className="btn" onClick={onExit}>
            回到题库
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="qb__review">
      <div className="qb__review-head">
        <button type="button" className="btn btn--small" onClick={onExit}>
          ← 回题库
        </button>
        <span className="qb__review-pos">{positionText}</span>
        <span className="muted qb__review-keys">← → 切题 · 空格翻面</span>
      </div>

      <div className={`qb__card qb__card--review ${flipped ? 'is-flipped' : ''}`}>
        <div className="qb__card-meta">
          <span className="chip">{current.category ? CATEGORY_LABEL[current.category] : '未分类'}</span>
          <span className="qb__difficulty">难度 {'★'.repeat(current.difficulty)}</span>
          <span className="muted">复习 {current.reviewCount} 次</span>
        </div>

        <div className="qb__card-body" ref={bodyRef}>
          <p className="qb__question">{current.text}</p>

          {flipped ? (
            <div className="qb__answer">
              {current.myAnswer ? (
                <>
                  <h4 className="qb__answer-title">我当时怎么答的</h4>
                  <p className="qb__answer-text">{current.myAnswer}</p>
                </>
              ) : (
                <p className="muted">这道题还没补「我当时怎么答的」。回头在面经编辑器里补上，比标 10 次掌握度都值。</p>
              )}
              {current.nextTime ? (
                <>
                  <h4 className="qb__answer-title">下次怎么改</h4>
                  <p className="qb__answer-text">{current.nextTime}</p>
                </>
              ) : null}
            </div>
          ) : (
            <p className="qb__flip-hint">先在心里答一遍，再按空格 / 点下面按钮翻面</p>
          )}
        </div>

        <div className="qb__card-actions">
          {!flipped ? (
            <button type="button" className="btn btn--primary" onClick={() => setFlipped(true)}>
              翻面看答案（空格）
            </button>
          ) : (
            <>
              <span className="qb__mark-hint">掌握度：</span>
              {([0, 1, 2] as const).map((level) => (
                <button
                  key={level}
                  type="button"
                  className={level === 0 ? 'btn btn--small' : 'btn btn--small btn--primary'}
                  onClick={() => mark(level)}
                >
                  {MASTERY_LABEL[level]}
                </button>
              ))}
            </>
          )}
        </div>
      </div>

      <div className="qb__review-foot">
        <button type="button" className="btn btn--small" onClick={() => go(-1)}>
          ← 上一张
        </button>
        <button type="button" className="btn btn--small" onClick={() => go(1)}>
          下一张 →
        </button>
      </div>
    </div>
  );
}
