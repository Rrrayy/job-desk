/**
 * 复盘：`[数据][面经]` 两个二级 tab。
 *
 * 数据 tab = v0.1 的漏斗 / 渠道回复率 / 简历版本面试率 / 每周投递量；
 * 面经 tab = 统计 + 题库 + 复习 + 导出（v0.2 新增）。
 * 一级 tab 仍然是 5 个 —— 面经不做一级入口（PRD §E.1）。
 */

import { useMemo, useState } from 'react';
import type { AppApi } from '../lib/api';
import {
  CHANNEL_LABEL,
  buildChannelStats,
  buildFunnel,
  buildResumeStats,
  buildWeeklyBuckets,
  weeklyAppliedCount,
} from '../lib/rules';
import { cx } from '../lib/util';
import { EXPERIENCE_RESULT_LABEL, pendingReviewInterviews, questionsOf } from '../lib/interview';
import { InsightsTabs } from './interview/InsightsTabs';
import { InterviewStats } from './interview/InterviewStats';
import { QuestionBank } from './interview/QuestionBank';

const pct = (value: number): string => `${Math.round(value * 100)}%`;

export function InsightsView({ api }: { api: AppApi }) {
  const { db, now } = api;
  const tab = api.insightsTab;
  const pendingReview = useMemo(() => pendingReviewInterviews(db, now), [db, now]);

  return (
    <div className="page">
      <div className="board-head">
        <h2 className="page__title">复盘</h2>
        <InsightsTabs tab={tab} onChange={api.setInsightsTab} pendingCount={pendingReview.length} />
      </div>

      {tab === 'data' ? <DataTab api={api} /> : <InterviewTab api={api} pendingCount={pendingReview.length} />}
    </div>
  );
}

/* ============================ 数据 tab ============================ */

function DataTab({ api }: { api: AppApi }) {
  const { db, now } = api;
  const funnel = useMemo(() => buildFunnel(db), [db]);
  const channels = useMemo(() => buildChannelStats(db), [db]);
  const resumes = useMemo(() => buildResumeStats(db), [db]);
  const weeks = useMemo(() => buildWeeklyBuckets(db.applications, 8, now), [db.applications, now]);
  const weekly = weeklyAppliedCount(db.applications, now);
  const topCount = funnel[0]?.count || 0;
  const maxWeek = Math.max(1, ...weeks.map((w) => w.count));
  const total = db.applications.length;

  if (total === 0) {
    return (
      <div className="empty-block">
        <div className="empty-block__emoji">📈</div>
        <h2 className="empty-block__title">先有数据，才有复盘。</h2>
        <p className="empty-block__text">
          数据还不够，先记录 5 家 —— 到那时候这里会长出漏斗、渠道回复率和每周节奏。
        </p>
        <button type="button" className="btn btn--primary btn--lg" onClick={() => api.openNew()}>
          ＋ 记第一家
        </button>
      </div>
    );
  }

  return (
    <>
      <span className="page__sub">
        共 {total} 条投递 · 本周新增 {weekly} 家
      </span>

      {total < 5 ? (
        <div className="notice notice--tip">
          数据还不够，先记录 5 家 —— 样本太小的时候，转化率只会误导你。
        </div>
      ) : null}

      <div className="insight-grid">
        <section className="card">
          <header className="card__head">
            <h2 className="card__title">漏斗</h2>
            <span className="card__hint">每一阶段 = 走到这一步及以后的公司数</span>
          </header>
          {topCount === 0 ? (
            <p className="muted">还没有投出去任何一家，漏斗是空的。</p>
          ) : (
            <div className="funnel">
              {funnel.map((stage, index) => {
                const width = Math.max(6, (stage.count / topCount) * 100);
                return (
                  <div key={stage.key} className="funnel__row funnel__row--wide">
                    <span className="funnel__label">{stage.label}</span>
                    <div className="funnel__track">
                      <div className="funnel__bar" style={{ width: `${width}%` }} />
                    </div>
                    <span className="funnel__count">{stage.count}</span>
                    <span className="funnel__rate">
                      {index === 0 ? '起点' : `转化 ${pct(stage.rate)}`}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="card">
          <header className="card__head">
            <h2 className="card__title">渠道回复率</h2>
            <span className="card__hint">走到「已沟通」及以后算有回复</span>
          </header>
          {channels.length === 0 ? (
            <p className="muted">还没记录渠道。</p>
          ) : (
            <ul className="stat-list">
              {channels.map((stat) => (
                <li key={stat.channel} className="stat-row">
                  <span className="stat-row__label">{CHANNEL_LABEL[stat.channel]}</span>
                  <div className="stat-row__track">
                    <div className="stat-row__bar" style={{ width: `${Math.max(3, stat.rate * 100)}%` }} />
                  </div>
                  <span className="stat-row__value">
                    {pct(stat.rate)}
                    <span className="stat-row__sub">
                      {stat.replied}/{stat.total}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="card__foot">
            样本少于 3 家的渠道，百分比仅供参考 —— 内推 1 家 100% 不代表什么。
          </p>
        </section>

        <section className="card">
          <header className="card__head">
            <h2 className="card__title">简历版本面试率</h2>
            <span className="card__hint">有任意面试记录即算进面</span>
          </header>
          {resumes.length === 0 ? (
            <p className="muted">还没记录简历版本。</p>
          ) : (
            <ul className="stat-list">
              {resumes.map((stat) => (
                // v0.9：聚合键从「版本名」改成了「版本 id」，两个版本可以同名、
                // 被删的版本还共用同一段兜底文案 —— 用 id 当 key 才不会撞键。
                // 没有 id 的两类桶（旧数据 / 未标注）文案天然不同，退回用文案即可。
                <li key={stat.versionId ?? stat.label} className="stat-row">
                  <span className="stat-row__label">{stat.version}</span>
                  <div className="stat-row__track">
                    <div
                      className="stat-row__bar stat-row__bar--alt"
                      style={{ width: `${Math.max(3, stat.rate * 100)}%` }}
                    />
                  </div>
                  <span className="stat-row__value">
                    {pct(stat.rate)}
                    <span className="stat-row__sub">
                      {stat.interviewed}/{stat.total}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <header className="card__head">
            <h2 className="card__title">每周投递量</h2>
            <span className="card__hint">最近 8 周</span>
          </header>
          <div className="weeks">
            {weeks.map((week, index) => (
              <div key={`${week.label}-${index}`} className="week-col">
                <span className="week-col__count">{week.count > 0 ? week.count : ''}</span>
                <div className="week-col__track">
                  <div
                    className={cx('week-col__bar', index === weeks.length - 1 && 'is-current')}
                    style={{ height: `${Math.max(week.count > 0 ? 6 : 2, (week.count / maxWeek) * 100)}%` }}
                  />
                </div>
                <span className="week-col__label">{week.label}</span>
              </div>
            ))}
          </div>
          <p className="card__foot">
            本周 {weekly}/{db.settings.weeklyApplyGoal} 家。
            {weekly > 12 ? '投得有点猛了，先把跟进做完再撒网。' : '节奏还行，稳住。'}
          </p>
        </section>
      </div>
    </>
  );
}

/* ============================ 面经 tab ============================ */

function InterviewTab({ api, pendingCount }: { api: AppApi; pendingCount: number }) {
  const { db } = api;
  const [desensitize, setDesensitize] = useState(true);

  const experiences = useMemo(
    () =>
      [...db.experiences].sort((a, b) =>
        a.interviewDate < b.interviewDate ? 1 : a.interviewDate > b.interviewDate ? -1 : 0,
      ),
    [db.experiences],
  );

  return (
    <>
      <div className="exp__head">
        <span className="page__sub">
          {experiences.length} 场面经 · {db.questions.length} 道题
          {pendingCount > 0 ? ` · ${pendingCount} 场面试还没复盘` : ''}
        </span>
        <div className="exp__head-actions">
          <button type="button" className="btn btn--primary btn--small" onClick={() => api.openQuickNote()}>
            ＋ 记面经
          </button>
          <label className="exp__desensitize">
            <input
              type="checkbox"
              checked={desensitize}
              onChange={(event) => setDesensitize(event.target.checked)}
            />
            <span>导出时脱敏</span>
          </label>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => api.exportExperienceMarkdown(experiences, { desensitize })}
            disabled={experiences.length === 0}
          >
            导出 Markdown
          </button>
        </div>
      </div>

      <section className="card">
        <header className="card__head">
          <h2 className="card__title">面经统计</h2>
          <span className="card__hint">哪类题最容易挂 · 这家爱问什么</span>
        </header>
        <InterviewStats db={db} />
      </section>

      <section className="card">
        <header className="card__head">
          <h2 className="card__title">题库与复习</h2>
          <span className="card__hint">不会的排前面，到期的标红</span>
        </header>
        <QuestionBank api={api} onRecord={() => api.openQuickNote()} />
      </section>

      <section className="card">
        <header className="card__head">
          <h2 className="card__title">面经列表</h2>
          <span className="card__hint">点开补「我当时怎么答的」</span>
        </header>
        {experiences.length === 0 ? (
          <p className="muted">还没有面经。点右上角「＋ 记面经」，一行一题，90 秒能记 5 题。</p>
        ) : (
          <ul className="exp__list">
            {experiences.map((experience) => {
              const count = questionsOf(db.questions, experience.id).length;
              return (
                <li key={experience.id} className="exp__list-item">
                  <button
                    type="button"
                    className="exp__list-main"
                    onClick={() => api.openExperience(experience.id)}
                  >
                    <span className="exp__list-company">{experience.companyName}</span>
                    <span className="exp__list-sub">
                      {experience.jobTitle ?? '（未填岗位）'}
                      {experience.round ? ` · 第 ${experience.round} 轮` : ''}
                    </span>
                    <span className="exp__list-meta">
                      {experience.interviewDate} · {EXPERIENCE_RESULT_LABEL[experience.result]} · {count} 题
                      {experience.source === 'community' ? ' · 社区导入' : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
