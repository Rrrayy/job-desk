/**
 * 今日（驾驶舱）—— 默认首页。
 * 回答一个问题：「我现在该干什么？」
 * 上半部：今天要做的 N 件事 / 本周投递进度 / 漏斗概览；下半部：最近动态时间线。
 */

import { useMemo, useState } from 'react';
import type { AppApi } from '../lib/api';
import {
  buildActionItems,
  buildDailyPlan,
  buildFunnel,
  buildTodos,
  interviewPhaseLabel,
  isMuted,
  type ActionItem,
  NOTE_TYPE_LABEL,
  recentNotes,
  weeklyAppliedCount,
} from '../lib/rules';
import { fmtDateTime, relativeCountdown } from '../lib/date';
import { pendingReviewInterviews } from '../lib/interview';
import { companyLabel, cx } from '../lib/util';

export function TodayView({ api }: { api: AppApi }) {
  const { db, now } = api;

  const todos = useMemo(() => buildTodos(db, now), [db, now]);
  const actions = useMemo(
    () => buildActionItems(todos, db.companies, db.settings, now),
    [todos, db.companies, db.settings, now],
  );
  /**
   * 行动预算：默认只露前 N 条，其余折叠。
   * 为什么不是「全列出来让用户自己挑」—— 12 条待办和 0 条待办对用户是同一种效果：
   * 都不动。排序已经是优先级，所以预算只负责「砍掉尾巴」，不负责重新排序。
   */
  const plan = useMemo(() => buildDailyPlan(actions, db.settings.dailyActionBudget), [actions, db.settings.dailyActionBudget]);
  const [showOverflow, setShowOverflow] = useState(false);
  const visibleActions = showOverflow ? actions : plan.primary;
  const mutedCount = useMemo(() => db.applications.filter((app) => isMuted(app, now)).length, [db.applications, now]);
  const funnel = useMemo(() => buildFunnel(db), [db]);
  const recent = useMemo(() => recentNotes(db.notes, 10), [db.notes]);
  // 与 TodoBar 共用同一个数据源（lib/interview.ts 的 pendingReviewInterviews），不各算一遍
  const pendingReviews = useMemo(() => pendingReviewInterviews(db, now), [db, now]);

  const weekly = weeklyAppliedCount(db.applications, now);
  const goal = Math.max(1, db.settings.weeklyApplyGoal);
  const ratio = Math.min(1, weekly / goal);
  const ringLength = 2 * Math.PI * 40;
  const topCount = funnel[0]?.count || 0;

  /**
   * 「✓」的含义按类型分：
   * - 沉默/该跟进 → 写一条催问记录（沉默计时立刻清零）
   * - 截止 → **不能**一键划掉：处理或放弃都得由人决定，只打开详情
   * - 其余 → 打开详情
   */
  const handleDone = (kind: ActionItem['kind'], appId: string): void => {
    if (kind === 'stale' || kind === 'warn') {
      api.addNote(appId, 'followup', '已催一下，等回复');
      api.toast('已记一条催问，沉默计时清零了');
      return;
    }
    api.openDetail(appId);
  };

  if (db.applications.length === 0) {
    return (
      <div className="page">
        <div className="empty-block">
          <div className="empty-block__emoji">📮</div>
          <h2 className="empty-block__title">还没有记录。</h2>
          <p className="empty-block__text">
            BOSS 上聊过的第一个人，值得被记住。
            <br />
            两个字段就能记一家：公司名 + 岗位名。
          </p>
          <div className="empty-block__actions">
            <button type="button" className="btn btn--primary btn--lg" onClick={() => api.openNew()}>
              ＋ 记下第一家
            </button>
            <button type="button" className="btn btn--lg" onClick={api.loadSampleData}>
              先看看示例数据
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="today-grid">
        {/* 今天要做的 N 件事 */}
        <section className="card card--actions">
          <header className="card__head">
            <h2 className="card__title">
              {actions.length === 0 ? '今天要做的 0 件事' : `今天要做的 ${actions.length} 件事`}
            </h2>
            <span className="card__hint">
              {mutedCount > 0 ? `${mutedCount} 家已静音 · ` : ''}红 &gt; 蓝 &gt; 黄，按紧急度排
            </span>
          </header>
          {actions.length === 0 ? (
            <div className="quiet">
              <p className="quiet__title">待办清空了。</p>
              <p className="quiet__text">手上没有要催的、没有要面的 —— 这时候最适合再投一家。</p>
              <button type="button" className="btn btn--small" onClick={() => api.openNew()}>
                ＋ 记一家
              </button>
            </div>
          ) : (
            <ul className="action-list">
              {visibleActions.map((item) => (
                <li key={item.key} className={cx('action-item', `action-item--${item.tone}`)}>
                  <button
                    type="button"
                    className="action-item__check"
                    title={item.doneHint}
                    onClick={() => handleDone(item.kind, item.appId)}
                  >
                    ✓
                  </button>
                  <div className="action-item__body">
                    <div className="action-item__title">{item.title}</div>
                    <div className="action-item__detail">{item.detail}</div>
                  </div>
                  <button
                    type="button"
                    className="btn btn--tiny"
                    onClick={() => api.openDetail(item.appId)}
                  >
                    {item.doneHint}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {plan.overflow.length > 0 ? (
            <p className="card__foot">
              <button
                type="button"
                className="link-btn"
                onClick={() => setShowOverflow((prev) => !prev)}
              >
                {showOverflow ? '收起' : `还有 ${plan.overflow.length} 件，展开看`}
              </button>
              {showOverflow ? null : <span className="card__hint">{'\u3000'}今天的预算就 {plan.budget} 件</span>}
            </p>
          ) : null}
        </section>

        {/* 本周投递进度 */}
        <section className="card card--ring">
          <header className="card__head">
            <h2 className="card__title">本周投递</h2>
          </header>
          <div className="ring">
            <svg viewBox="0 0 100 100" className="ring__svg" aria-hidden="true">
              <circle cx="50" cy="50" r="40" className="ring__track" />
              <circle
                cx="50"
                cy="50"
                r="40"
                className="ring__value"
                strokeDasharray={`${ringLength * ratio} ${ringLength}`}
                strokeLinecap="round"
              />
            </svg>
            <div className="ring__center">
              <span className="ring__num">
                {weekly}
                <span className="ring__goal">/{goal}</span>
              </span>
              <span className="ring__label">家</span>
            </div>
          </div>
          <p className="ring__hint">
            {weekly === 0
              ? '这周还一家没投，今天补一家？'
              : weekly >= goal
                ? weekly >= 12
                  ? '本周投得有点多了，先把手上的跟进完。'
                  : '目标达成，剩下的是跟进。'
                : `离目标还差 ${goal - weekly} 家`}
          </p>
          <button type="button" className="btn btn--small" onClick={() => api.openNew()}>
            ＋ 记一家
          </button>
        </section>

        {/* 漏斗概览 */}
        <section className="card card--funnel">
          <header className="card__head">
            <h2 className="card__title">漏斗概览</h2>
            <button type="button" className="link-btn" onClick={() => api.setView('insights')}>
              看复盘 →
            </button>
          </header>
          <div className="funnel funnel--compact">
            {funnel.map((stage) => {
              const width = topCount > 0 ? Math.max(4, (stage.count / topCount) * 100) : 4;
              return (
                <div key={stage.key} className="funnel__row">
                  <span className="funnel__label">{stage.label}</span>
                  <div className="funnel__track">
                    <div className="funnel__bar" style={{ width: `${width}%` }} />
                  </div>
                  <span className="funnel__count">{stage.count}</span>
                </div>
              );
            })}
          </div>
          {topCount === 0 ? <p className="card__foot">再投 1 家就能看到转化率了。</p> : null}
        </section>
      </div>

      {/* 待复盘面试：面完了、结果也记了、但还没记面经 —— 这是唯一会「过期作废」的事，所以单独一张卡 */}
      {pendingReviews.length > 0 ? (
        <section className="card card--revisit">
          <header className="card__head">
            <h2 className="card__title">{pendingReviews.length} 场面试待复盘</h2>
            <span className="card__hint">趁记忆还热，一天后细节就掉一半</span>
          </header>
          <ul className="revisit-list">
            {pendingReviews.slice(0, 3).map((item) => (
              <li key={item.interview.id} className="revisit-item">
                <div className="revisit-main">
                  <div className="revisit-title">
                    {item.companyName}
                    {item.jobTitle ? ` · ${item.jobTitle}` : ''}
                  </div>
                  <div className="revisit-meta">
                    第 {item.round} 轮 · {item.interviewDate}
                    {item.interview.result === 'failed' ? ' · 挂了，更值得记' : ''}
                  </div>
                </div>
                <div className="revisit-actions">
                  <button
                    type="button"
                    className="btn btn--primary btn--tiny"
                    onClick={() =>
                      api.openQuickNote({
                        applicationId: item.applicationId,
                        companyName: item.companyName,
                        jobTitle: item.jobTitle,
                        round: item.round,
                        interviewDate: item.interviewDate,
                      })
                    }
                  >
                    记面经
                  </button>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => api.openDetail(item.applicationId)}
                  >
                    看投递 →
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {pendingReviews.length > 3 ? (
            <p className="card__foot">还有 {pendingReviews.length - 3} 场，去「复盘 → 面经」里一起补。</p>
          ) : null}
          <p className="card__foot">
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                api.setInsightsTab('interview');
                api.setView('insights');
              }}
            >
              去面经板块 →
            </button>
          </p>
        </section>
      ) : null}

      {/* 最近动态 */}
      <section className="card">
        <header className="card__head">
          <h2 className="card__title">最近动态</h2>
          <span className="card__hint">跨公司最近 {recent.length} 条</span>
        </header>
        {recent.length === 0 ? (
          <div className="quiet">
            <p className="quiet__title">还没有任何动态。</p>
            <p className="quiet__text">每记一条沟通，沉默计时就会清零 —— 这就是它唯一的用处。</p>
          </div>
        ) : (
          <ol className="timeline timeline--recent">
            {recent.map((note) => {
              const app = db.applications.find((a) => a.id === note.applicationId);
              const company = app ? companyLabel(db.companies, app.companyId) : '未知公司';
              return (
                <li key={note.id} className={cx('timeline__item', note.auto && 'is-auto')}>
                  <span className={cx('timeline__dot', `timeline__dot--${note.type}`)} />
                  <div className="timeline__body">
                    <div className="timeline__meta">
                      <button
                        type="button"
                        className="timeline__who"
                        onClick={() => app && api.openDetail(app.id)}
                      >
                        {company}
                        {app ? ` · ${app.jobTitle}` : ''}
                      </button>
                      <span className="timeline__badge">{NOTE_TYPE_LABEL[note.type]}</span>
                      <span className="timeline__time">{fmtDateTime(note.touchedAt)}</span>
                    </div>
                    <p className="timeline__content">{note.content}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {todos.todayInterview.length > 0 ? (
        <section className="card card--today-interview">
          <header className="card__head">
            <h2 className="card__title">今天的面试</h2>
          </header>
          <ul className="mini-list">
            {todos.todayInterview.map((item) => {
              const phase = interviewPhaseLabel(item.interview, now, db.settings);
              return (
                <li key={item.interview.id} className="mini-list__item">
                  <span className="mini-list__time">{relativeCountdown(item.at, now)}</span>
                  <span className="mini-list__main">
                    {companyLabel(db.companies, item.app.companyId)} · {item.app.jobTitle}（第{' '}
                    {item.interview.round} 轮）
                  </span>
                  {phase ? <span className="mini-list__phase">{phase}</span> : null}
                  <button type="button" className="btn btn--tiny" onClick={() => api.openDetail(item.app.id)}>
                    打开
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
