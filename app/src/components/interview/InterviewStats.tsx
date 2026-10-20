/**
 * 复盘 → [面经] 二级 tab 里的统计块。
 *
 * 三条硬规则（PRD §E.4）：
 * 1. 没有数据时**不画空图**，给一句能立刻照做的引导；
 * 2. 「易挂题型」的分母是「挂掉的场次数」，不是题目数（否则一道题挂 5 次会骗人）；
 * 3. 公司高频题按题干去重计数，同题不同场次算同一题。
 */

import type { DB } from '../../types';
import { statsByCategory, statsByCompany, statsByRootCause } from '../../lib/interview';

export function InterviewStats({ db }: { db: DB }) {
  const byCategory = statsByCategory(db);
  const byCompany = statsByCompany(db).slice(0, 5);
  const byRootCause = statsByRootCause(db);
  const totalQuestions = db.questions.length;
  const totalExperiences = db.experiences.length;

  if (totalQuestions === 0) {
    return (
      <div className="empty-block">
        <div className="empty-block__emoji">📝</div>
        <div className="empty-block__title">还没有面经数据</div>
        <p className="empty-block__text">
          面完一场就点「＋ 记面经」，一行一题记下来（Enter 连记，90 秒能记 5 题）。
          记满 3 场之后，这里会告诉你「哪类题最容易挂」和「这家公司爱问什么」。
        </p>
      </div>
    );
  }

  return (
    <div className="exp__stats">
      <div className="exp__stat-cards">
        <div className="exp__stat-card">
          <span className="exp__stat-value">{totalExperiences}</span>
          <span className="exp__stat-label">场面试</span>
        </div>
        <div className="exp__stat-card">
          <span className="exp__stat-value">{totalQuestions}</span>
          <span className="exp__stat-label">道题</span>
        </div>
        <div className="exp__stat-card">
          <span className="exp__stat-value">{db.questions.filter((q) => q.mastery === 0).length}</span>
          <span className="exp__stat-label">还不会</span>
        </div>
      </div>

      <section className="exp__stat-block">
        <h3 className="exp__stat-title">哪类题最容易挂</h3>
        <p className="exp__stat-hint">分母是「挂掉的场次数」—— 同一场里同类题只算一次，避免一道题重复计。</p>
        {byCategory.length === 0 ? (
          <p className="muted">还没有标记分类的题目。记面经时顺手选一下分类就能看出来。</p>
        ) : (
          <ul className="exp__bars">
            {byCategory.map((stat) => (
              <li key={stat.category ?? 'none'} className="exp__bar-row">
                <span className="exp__bar-label">{stat.label}</span>
                <span className="exp__bar-track">
                  <span className="exp__bar-fill" style={{ width: `${Math.round(stat.rate * 100)}%` }} />
                </span>
                <span className="exp__bar-value">
                  {stat.failedAppearances} 场挂过 · 共 {stat.total} 题
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="exp__stat-block">
        <h3 className="exp__stat-title">公司高频题（Top 5 公司）</h3>
        {byCompany.length === 0 ? (
          <p className="muted">还没有数据。</p>
        ) : (
          <ul className="exp__company-list">
            {byCompany.map((company) => (
              <li key={company.companyName} className="exp__company-item">
                <div className="exp__company-head">
                  <strong>{company.companyName}</strong>
                  <span className="muted">{company.totalQuestions} 题</span>
                </div>
                <ul className="exp__company-questions">
                  {company.items.slice(0, 3).map((item) => (
                    <li key={item.text}>
                      <span className="exp__company-q">{item.text}</span>
                      {item.count > 1 ? <span className="exp__count-chip">×{item.count}</span> : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="exp__stat-block">
        <h3 className="exp__stat-title">挂的原因分布</h3>
        {byRootCause.length === 0 ? (
          <p className="muted">还没有标记原因。复盘时标一次，下次就知道该练什么。</p>
        ) : (
          <ul className="exp__bars">
            {byRootCause.map((stat) => {
              const max = byRootCause[0]?.count || 1;
              return (
                <li key={stat.rootCause ?? 'none'} className="exp__bar-row">
                  <span className="exp__bar-label">{stat.label}</span>
                  <span className="exp__bar-track">
                    <span className="exp__bar-fill" style={{ width: `${Math.round((stat.count / max) * 100)}%` }} />
                  </span>
                  <span className="exp__bar-value">{stat.count} 题</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
