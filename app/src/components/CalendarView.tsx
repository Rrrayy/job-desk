/**
 * 面试日历：月视图网格 + 右侧当日面试卡片。
 * 面试时间与同一天的其他面试、或每周固定课程重叠时，卡片显示「⚠ 时间冲突」并说明冲突对象。
 */

import { useMemo, useState } from 'react';
import type { AppApi } from '../lib/api';
import type { Interview } from '../types';
import { FORMAT_LABEL, RESULT_LABEL, findConflicts, interviewsOnDay } from '../lib/rules';
import {
  WEEKDAY_CN,
  addDays,
  addMonths,
  fmtTime,
  isSameDay,
  parseFlexible,
  toDateISO,
  weekdayOf,
} from '../lib/date';
import { companyLabel, cx } from '../lib/util';

interface Cell {
  date: Date;
  inMonth: boolean;
}

export function CalendarView({ api }: { api: AppApi }) {
  const { db, now } = api;
  const [cursor, setCursor] = useState<Date>(() => new Date(now.getFullYear(), now.getMonth(), 1));
  const [selected, setSelected] = useState<string>(() => toDateISO(now));

  const cells = useMemo<Cell[]>(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const offset = weekdayOf(first) - 1;
    const start = addDays(first, -offset);
    const list: Cell[] = [];
    for (let i = 0; i < 42; i += 1) {
      const date = addDays(start, i);
      list.push({ date, inMonth: date.getMonth() === cursor.getMonth() });
    }
    return list;
  }, [cursor]);

  /** 每场面试的冲突信息只算一次 */
  const conflictMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const interview of db.interviews) {
      map.set(interview.id, findConflicts(interview, db.interviews, db.applications, db.settings));
    }
    return map;
  }, [db.interviews, db.applications, db.settings]);

  const conflictTotal = useMemo(() => {
    let count = 0;
    for (const messages of conflictMap.values()) {
      if (messages.length > 0) count += 1;
    }
    return count;
  }, [conflictMap]);

  const appOf = (interview: Interview) => db.applications.find((a) => a.id === interview.applicationId);

  const selectedDate = parseFlexible(selected);
  const dayInterviews = interviewsOnDay(db.interviews, selectedDate);
  const dayCourses = db.settings.courseSlots.filter(
    (slot) => slot.weekday === weekdayOf(selectedDate),
  );

  return (
    <div className="page">
      <div className="board-head">
        <h2 className="page__title">面试日历</h2>
        <span className="page__sub">
          {db.interviews.length} 场面试
          {conflictTotal > 0 ? ` · ⚠ ${conflictTotal} 处时间冲突` : ' · 暂无时间冲突'}
        </span>
      </div>

      <div className="cal">
        <section className="cal__main card card--flat">
          <header className="cal__head">
            <div className="cal__nav">
              <button
                type="button"
                className="icon-btn"
                onClick={() => setCursor(addMonths(cursor, -1))}
                title="上个月"
              >
                ‹
              </button>
              <span className="cal__month">
                {cursor.getFullYear()} 年 {cursor.getMonth() + 1} 月
              </span>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setCursor(addMonths(cursor, 1))}
                title="下个月"
              >
                ›
              </button>
            </div>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => {
                setCursor(new Date(now.getFullYear(), now.getMonth(), 1));
                setSelected(toDateISO(now));
              }}
            >
              回到今天
            </button>
          </header>

          <div className="cal__weekdays">
            {WEEKDAY_CN.map((label) => (
              <span key={label} className="cal__weekday">
                {label}
              </span>
            ))}
          </div>

          <div className="cal__grid">
            {cells.map((cell) => {
              const key = toDateISO(cell.date);
              const list = interviewsOnDay(db.interviews, cell.date);
              const today = isSameDay(cell.date, now);
              const hasConflict = list.some((iv) => (conflictMap.get(iv.id) || []).length > 0);
              return (
                <button
                  key={key}
                  type="button"
                  className={cx(
                    'cal__cell',
                    !cell.inMonth && 'is-outside',
                    today && 'is-today',
                    key === selected && 'is-selected',
                  )}
                  onClick={() => setSelected(key)}
                >
                  <span className="cal__date">{cell.date.getDate()}</span>
                  <div className="cal__chips">
                    {list.slice(0, 3).map((iv) => {
                      const app = appOf(iv);
                      return (
                        <span
                          key={iv.id}
                          className={cx(
                            'cal__chip',
                            iv.result === 'passed' && 'cal__chip--passed',
                            iv.result === 'failed' && 'cal__chip--failed',
                          )}
                        >
                          {fmtTime(iv.scheduledAt)} {app ? companyLabel(db.companies, app.companyId) : '面试'}
                        </span>
                      );
                    })}
                    {list.length > 3 ? <span className="cal__more">+{list.length - 3}</span> : null}
                  </div>
                  {hasConflict ? <span className="cal__warn">⚠</span> : null}
                </button>
              );
            })}
          </div>
        </section>

        <aside className="cal__side card card--flat">
          <header className="cal__side-head">
            <h3 className="cal__side-title">
              {selectedDate.getMonth() + 1} 月 {selectedDate.getDate()} 日 {WEEKDAY_CN[weekdayOf(selectedDate) - 1]}
              {isSameDay(selectedDate, now) ? '（今天）' : ''}
            </h3>
          </header>

          {dayCourses.length > 0 ? (
            <div className="cal__course">
              {dayCourses.map((slot, index) => (
                <p key={`${slot.name}-${index}`} className="cal__course-item">
                  课程《{slot.name}》 {slot.start}-{slot.end}
                </p>
              ))}
            </div>
          ) : null}

          {dayInterviews.length === 0 ? (
            <div className="quiet">
              <p className="quiet__title">这天没有面试。</p>
              <p className="quiet__text">松一口气，或者去把该催的那家催了。</p>
            </div>
          ) : (
            <ul className="cal__list">
              {dayInterviews.map((iv) => {
                const app = appOf(iv);
                const conflicts = conflictMap.get(iv.id) || [];
                const done = (iv.prepChecklist || []).filter((p) => p.done).length;
                const totalPrep = (iv.prepChecklist || []).length;
                return (
                  <li key={iv.id} className="cal__item">
                    <div className="cal__item-head">
                      <span className="cal__item-time">{fmtTime(iv.scheduledAt)}</span>
                      <span className="cal__item-title">
                        {app ? `${companyLabel(db.companies, app.companyId)} · ${app.jobTitle}` : '未知投递'}
                      </span>
                    </div>
                    <div className="cal__item-meta">
                      第 {iv.round} 轮 · {FORMAT_LABEL[iv.format]}
                      {iv.locationOrLink ? ` · ${iv.locationOrLink}` : ''}
                      {iv.durationMin ? ` · ${iv.durationMin} 分钟` : ''} · {RESULT_LABEL[iv.result]}
                    </div>
                    {totalPrep > 0 ? (
                      <div className="cal__item-prep">
                        准备清单 {done}/{totalPrep}
                      </div>
                    ) : null}
                    {conflicts.length > 0 ? (
                      <div className="cal__item-conflict">
                        <strong>⚠ 时间冲突</strong>
                        {conflicts.map((message) => (
                          <p key={message}>{message}</p>
                        ))}
                      </div>
                    ) : null}
                    <div className="cal__item-actions">
                      <button
                        type="button"
                        className="btn btn--tiny"
                        onClick={() => app && api.openDetail(app.id)}
                      >
                        打开这家
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
