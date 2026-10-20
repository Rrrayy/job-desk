/**
 * 常驻「今日待办条」—— 这个产品的心跳。
 * 不论切到哪个视图，都必须第一眼看到「有事没处理」；没有待办时给一句安抚文案，不留空白。
 */

import { useMemo } from 'react';
import type { AppApi } from '../lib/api';
import { buildTodos } from '../lib/rules';
import { pendingReviewInterviews } from '../lib/interview';

export function TodoBar({ api }: { api: AppApi }) {
  const todos = useMemo(() => buildTodos(api.db, api.now), [api.db, api.now]);
  const pendingReview = useMemo(() => pendingReviewInterviews(api.db, api.now), [api.db, api.now]);

  const staleCount = todos.stale.length;
  const warnCount = todos.warn.length;
  const todayCount = todos.todayInterview.length;
  const resultCount = todos.needResult.length;
  const wishCount = todos.wishlistExpired.length;
  const reviewCount = pendingReview.length;
  const stagedCount = api.db.staging.length;
  const conflictStagedCount = api.db.staging.filter((item) => item.reason === 'conflict').length;
  const total =
    staleCount + warnCount + todayCount + resultCount + wishCount + reviewCount + stagedCount;

  if (total === 0) {
    return (
      <div className="todobar todobar--calm">
        <span className="todobar__calm-text">
          今天没有待处理的事 —— 手上的都在正常推进。可以顺手去投一家新的。
        </span>
      </div>
    );
  }

  const firstStale = todos.stale[0];
  const firstToday = todos.todayInterview[0];
  const firstWarn = todos.warn[0] || todos.wishlistExpired[0];

  return (
    <div className="todobar">
      {staleCount > 0 ? (
        <button
          type="button"
          className="pill pill--red"
          onClick={() => firstStale && api.focusApp(firstStale.app.id)}
          title="点击跳到最该处理的那一家"
        >
          <span className="pill__dot" />
          {staleCount} 家已沉默
          <span className="pill__extra">最长 {Math.max(...todos.stale.map((item) => item.days))} 天</span>
        </button>
      ) : null}

      {todayCount > 0 && firstToday ? (
        <button
          type="button"
          className="pill pill--blue"
          onClick={() => api.openDetail(firstToday.app.id)}
          title="打开这家的面试详情"
        >
          <span className="pill__dot" />
          今天有 {todayCount} 场面试
        </button>
      ) : null}

      {resultCount > 0 ? (
        <button
          type="button"
          className="pill pill--blue"
          onClick={() => api.openDetail(todos.needResult[0].app.id)}
          title="面试完了但还没记结果"
        >
          <span className="pill__dot" />
          {resultCount} 场待记结果
        </button>
      ) : null}

      {warnCount > 0 ? (
        <button
          type="button"
          className="pill pill--amber"
          onClick={() => firstWarn && api.focusApp(firstWarn.app.id)}
        >
          <span className="pill__dot" />
          {warnCount} 家该跟进了
        </button>
      ) : null}

      {wishCount > 0 ? (
        <button
          type="button"
          className="pill pill--amber"
          onClick={() => api.openDetail(todos.wishlistExpired[0].app.id)}
        >
          <span className="pill__dot" />
          {wishCount} 家还想投吗？
        </button>
      ) : null}

      {reviewCount > 0 ? (
        <button
          type="button"
          className="pill pill--blue"
          onClick={() => api.setInsightsTab('interview')}
          title="记完面经就会从这条清单里消失"
        >
          <span className="pill__dot" />
          {reviewCount} 场面试待复盘
        </button>
      ) : null}

      {stagedCount > 0 ? (
        <button
          type="button"
          className="pill pill--amber"
          onClick={() => api.openSync()}
          title="同步时没能自动判定的记录，一条都没丢，等你归类"
        >
          <span className="pill__dot" />
          {conflictStagedCount > 0
            ? `${conflictStagedCount} 条冲突待决`
            : `${stagedCount} 条同步待确认`}
        </button>
      ) : null}
    </div>
  );
}
