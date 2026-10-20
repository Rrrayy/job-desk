/**
 * 面试日历：月视图网格 + 右侧当日卡片。
 * 日历上什么都能标：面试、课表导入的课、手动记的事（组会、急事……）。
 * 同一天 + 时间重叠就报「⚠ 时间冲突」，面试和日程在同一个池子里两两比对。
 * v0.4：新增「记一件事」「导入课表」；废弃 settings.courseSlots（见 validateV2 的一次性迁移）。
 */

import { useMemo, useState } from 'react';
import type { AppApi } from '../lib/api';
import { FORMAT_LABEL, RESULT_LABEL, eventsOnDate, findConflicts, findEventConflicts, interviewsOnDay } from '../lib/rules';
import { parseCourseLines } from '../lib/courseImport';
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
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickTitle, setQuickTitle] = useState('');
  const [quickStart, setQuickStart] = useState('09:00');
  const [quickEnd, setQuickEnd] = useState('10:00');

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

  /** 每场面试的冲突信息只算一次（现在也包含与日程的冲突） */
  const conflictMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const interview of db.interviews) {
      map.set(interview.id, findConflicts(interview, db.interviews, db.applications, db.events));
    }
    return map;
  }, [db.interviews, db.applications, db.events]);

  const appOf = (interview: { applicationId: string }) =>
    db.applications.find((a) => a.id === interview.applicationId);

  const selectedDate = parseFlexible(selected);
  const dayInterviews = interviewsOnDay(db.interviews, selectedDate);
  const dayEvents = eventsOnDate(db.events, selectedDate);

  /** 当天每条日程的冲突信息（在侧栏展示） */
  const dayEventConflicts = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const event of dayEvents) {
      map.set(event.id, findEventConflicts(event, db.events, db.interviews, db.applications));
    }
    return map;
  }, [dayEvents, db.events, db.interviews, db.applications]);

  /** 全月冲突数：面试冲突 + 当月日程冲突（周课按当月出现次数计，够用作警示量级） */
  const conflictTotal = useMemo(() => {
    let count = 0;
    for (const messages of conflictMap.values()) {
      if (messages.length > 0) count += 1;
    }
    for (const event of db.events) {
      if (findEventConflicts(event, db.events, db.interviews, db.applications).length > 0) count += 1;
    }
    return count;
  }, [db.events, db.interviews, db.applications, conflictMap]);

  /** 某天有没有任何冲突（月格的 ⚠ 角标） */
  const dayHasConflict = (date: Date): boolean => {
    const list = interviewsOnDay(db.interviews, date);
    if (list.some((iv) => (conflictMap.get(iv.id) || []).length > 0)) return true;
    for (const event of eventsOnDate(db.events, date)) {
      if (findEventConflicts(event, db.events, db.interviews, db.applications).length > 0) return true;
    }
    return false;
  };

  /* ---------------- 导入课表 ---------------- */

  const parsed = useMemo(
    () => (importOpen ? parseCourseLines(importText) : { ok: [], skipped: [] }),
    [importOpen, importText],
  );

  const confirmImport = (): void => {
    const count = api.importCourseEvents(parsed.ok);
    if (count > 0) {
      api.toast(`已导入 ${count} 节课（替换原课表，手动记的事不受影响）`);
      setImportOpen(false);
      setImportText('');
    } else {
      api.toast('没有识别出任何一节课 —— 检查一下格式');
    }
  };

  /* ---------------- 记一件事 ---------------- */

  const confirmQuickAdd = (): void => {
    const title = quickTitle.trim();
    if (!title) {
      api.toast('先写上这是什么事');
      return;
    }
    if (quickStart >= quickEnd) {
      api.toast('结束时间要晚于开始时间');
      return;
    }
    api.addCalendarEvent({ title, start: quickStart, end: quickEnd, date: selected, weekly: false });
    api.toast('已记下：' + title);
    setQuickOpen(false);
    setQuickTitle('');
  };

  return (
    <div className="page">
      <div className="board-head">
        <h2 className="page__title">面试日历</h2>
        <span className="page__sub">
          {db.interviews.length} 场面试 · {db.events.length} 条日程
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
            <div className="btn-row">
              <button
                type="button"
                className="btn btn--small"
                onClick={() => setQuickOpen((open) => !open)}
              >
                ＋ 记一件事
              </button>
              <button
                type="button"
                className={cx('btn btn--small', !importOpen && 'btn--primary')}
                onClick={() => setImportOpen((open) => !open)}
              >
                导入课表
              </button>
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
            </div>
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
              const events = eventsOnDate(db.events, cell.date);
              const today = isSameDay(cell.date, now);
              const hasConflict = dayHasConflict(cell.date);
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
                    {list.slice(0, 2).map((iv) => {
                      const app = appOf(iv);
                      return (
                        <span key={iv.id} className="cal__chip">
                          {fmtTime(iv.scheduledAt)} {app ? companyLabel(db.companies, app.companyId) : '面试'}
                        </span>
                      );
                    })}
                    {events.slice(0, 3 - Math.min(2, list.length)).map((event) => (
                      <span
                        key={event.id}
                        className={cx('cal__chip', 'cal__chip--event')}
                      >
                        {fmtTime(`${key}T${event.start}:00`)} {event.title}
                      </span>
                    ))}
                    {list.length + events.length > 3 ? (
                      <span className="cal__more">+{list.length + events.length - 3}</span>
                    ) : null}
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

          {importOpen ? (
            <div className="cal__import">
              <p className="field__hint">
                一行一节课，从课表 App / 教务网页直接复制就行（周几 + 时间 + 名字，顺序随意）：
              </p>
              <p className="field__hint">
                <code>周一 08:00-09:40 数据结构</code>
              </p>
              <textarea
                className="input cal__import-text"
                rows={6}
                value={importText}
                placeholder={'周一 08:00-09:40 数据结构\n星期三 14:00~15:40 计算机网络\n周五 18:30-20:10 选修课'}
                onChange={(event) => setImportText(event.target.value)}
              />
              {parsed.ok.length > 0 || parsed.skipped.length > 0 ? (
                <p className="field__hint">
                  识别出 <strong>{parsed.ok.length}</strong> 节课
                  {parsed.skipped.length > 0 ? `，${parsed.skipped.length} 行没认出来` : ''}
                </p>
              ) : null}
              {parsed.skipped.map(({ line, reason }) => (
                <p key={line} className="cal__import-skip">
                  ✕ {line} —— {reason}
                </p>
              ))}
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn--small btn--primary"
                  disabled={parsed.ok.length === 0}
                  onClick={confirmImport}
                >
                  导入 {parsed.ok.length > 0 ? `${parsed.ok.length} 节` : ''}
                </button>
                <button type="button" className="btn btn--small" onClick={() => setImportOpen(false)}>
                  收起
                </button>
              </div>
              <p className="field__hint">导入会替换之前的课表；手动记的事不受影响。</p>
            </div>
          ) : null}

          {quickOpen ? (
            <div className="cal__import">
              <p className="field__hint">记在 {selectedDate.getMonth() + 1} 月 {selectedDate.getDate()} 日：</p>
              <input
                className="input"
                value={quickTitle}
                placeholder="什么事？（例：导师组会 / 体检 / 交材料）"
                onChange={(event) => setQuickTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') confirmQuickAdd();
                }}
              />
              <div className="cal__import-times">
                <input
                  className="input input--compact"
                  type="time"
                  value={quickStart}
                  onChange={(event) => setQuickStart(event.target.value)}
                />
                <span className="muted">至</span>
                <input
                  className="input input--compact"
                  type="time"
                  value={quickEnd}
                  onChange={(event) => setQuickEnd(event.target.value)}
                />
              </div>
              <div className="btn-row">
                <button type="button" className="btn btn--small btn--primary" onClick={confirmQuickAdd}>
                  记下
                </button>
                <button type="button" className="btn btn--small" onClick={() => setQuickOpen(false)}>
                  取消
                </button>
              </div>
            </div>
          ) : null}

          {dayEvents.length > 0 ? (
            <div className="cal__course">
              {dayEvents.map((event) => {
                const conflicts = dayEventConflicts.get(event.id) || [];
                return (
                  <div key={event.id} className="cal__event-item">
                    <span className={cx('cal__event-tag', event.kind === 'course' && 'cal__event-tag--course')}>
                      {event.kind === 'course' ? '课' : '事'}
                    </span>
                    <span className="cal__event-text">
                      《{event.title}》 {event.start}-{event.end}
                      {event.weekly ? '（每周）' : ''}
                    </span>
                    <button
                      type="button"
                      className="link-btn link-btn--danger cal__event-del"
                      title="删掉这条日程"
                      onClick={() => api.deleteCalendarEvent(event.id)}
                    >
                      ✕
                    </button>
                    {conflicts.length > 0 ? (
                      <div className="cal__item-conflict">
                        <strong>⚠ 时间冲突</strong>
                        {conflicts.map((message) => (
                          <p key={message}>{message}</p>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          {dayInterviews.length === 0 ? (
            dayEvents.length === 0 ? (
              <div className="quiet">
                <p className="quiet__title">这天什么都没有。</p>
                <p className="quiet__text">点上面的「记一件事」把要紧事标上来，撞了会提醒。</p>
              </div>
            ) : (
              <div className="quiet">
                <p className="quiet__title">这天没有面试。</p>
              </div>
            )
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
