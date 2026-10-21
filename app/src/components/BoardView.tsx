/**
 * 看板：横向 6 列 + 右侧可折叠「已结束」列。
 * 拖拽落列即改状态；落列后弹一个 3 字段轻面板（日期 / 备注 / 轮次），
 * Esc 或点空白即跳过，但状态照常生效。卡片右上角「⋯」是拖拽不可用时的兜底。
 */

import { useMemo, useRef, useState } from 'react';
import type { AppApi } from '../lib/api';
import type { Application, Status } from '../types';
import {
  BOARD_COLUMNS,
  ENDED_STATUSES,
  NOTE_TYPE_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  buildNoteIndex,
  interviewPhaseLabel,
  latestUserNoteOf,
  nextInterviewOf,
  silenceStateOf,
  suggestionFor,
} from '../lib/rules';
import { parseFlexible, relativeCountdown, toDateISO } from '../lib/date';
import { companyLabel, cx } from '../lib/util';

interface DropPanelState {
  appId: string;
  from: Status;
  to: Status;
}

export function BoardView({ api }: { api: AppApi }) {
  const { db, now } = api;
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<Status | null>(null);
  const [endedOpen, setEndedOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dropPanel, setDropPanel] = useState<DropPanelState | null>(null);

  /** 时间线索引：看板一次渲染要给每张卡算沉默和条数，不能每张卡都扫一遍全库 */
  const noteIndex = useMemo(() => buildNoteIndex(db.notes), [db.notes]);

  const byStatus = useMemo(() => {
    const map = new Map<Status, Application[]>();
    for (const status of [...BOARD_COLUMNS, ...ENDED_STATUSES]) map.set(status, []);
    for (const app of db.applications) {
      const bucket = map.get(app.status);
      if (bucket) bucket.push(app);
    }
    return map;
  }, [db.applications]);

  const totalActive = BOARD_COLUMNS.reduce((sum, status) => sum + (byStatus.get(status)?.length || 0), 0);
  const endedCount = ENDED_STATUSES.reduce((sum, status) => sum + (byStatus.get(status)?.length || 0), 0);

  const handleDrop = (event: React.DragEvent<HTMLDivElement>, to: Status): void => {
    event.preventDefault();
    setOverColumn(null);
    const id = event.dataTransfer.getData('text/plain') || draggingId;
    setDraggingId(null);
    if (!id) return;
    const app = db.applications.find((item) => item.id === id);
    if (!app || app.status === to) return;
    const from = app.status;
    api.changeStatus(id, to);
    setDropPanel({ appId: id, from, to });
  };

  const handleMenuPick = (app: Application, to: Status): void => {
    setMenuFor(null);
    if (app.status === to) return;
    api.changeStatus(app.id, to);
    setDropPanel({ appId: app.id, from: app.status, to });
  };

  const renderCard = (app: Application) => {
    const silence = silenceStateOf(app, db.notes, db.settings, now, noteIndex);
    const next = nextInterviewOf(db.interviews, app.id, now);
    const nextPhase = next ? interviewPhaseLabel(next, now, db.settings) : '';
    const suggestion = suggestionFor(app, silence);
    const noteCount = noteIndex.get(app.id)?.length ?? 0;
    // v0.5：卡片上直接露出最新一条「我写的」记录 —— 不点开详情也能想起进度。
    // auto 流水（同步/示例）不占这个位置，见 latestUserNoteOf 的注释。
    const latestNote = latestUserNoteOf(noteIndex, app.id);
    const isEnded = ENDED_STATUSES.includes(app.status);

    return (
      <article
        key={app.id}
        className={cx(
          'app-card',
          silence.level === 'stale' && 'app-card--stale',
          silence.level === 'warn' && 'app-card--warn',
          api.highlightedId === app.id && 'is-highlight',
          draggingId === app.id && 'is-dragging',
        )}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData('text/plain', app.id);
          event.dataTransfer.effectAllowed = 'move';
          setDraggingId(app.id);
        }}
        onDragEnd={() => {
          setDraggingId(null);
          setOverColumn(null);
        }}
        onClick={() => api.openDetail(app.id)}
      >
        <div className="app-card__top">
          <div className="app-card__names">
            <span className="app-card__company">{companyLabel(db.companies, app.companyId)}</span>
            <span className="app-card__job">{app.jobTitle}</span>
          </div>
          <button
            type="button"
            className="kebab"
            title="改状态（拖拽不可用时用这个）"
            onClick={(event) => {
              event.stopPropagation();
              setMenuFor(menuFor === app.id ? null : app.id);
            }}
          >
            ⋯
          </button>
        </div>

        <div className="app-card__meta">
          {[app.city, app.channel ? chLabel(app.channel) : '', app.salaryText]
            .filter(Boolean)
            .join(' · ') || '还没填城市 / 渠道'}
        </div>

        {latestNote ? (
          // title 里放全文：一行截断不可避免，悬停能看到完整的
          <div
            className="app-card__note"
            title={`${NOTE_TYPE_LABEL[latestNote.type]} · ${latestNote.content}`}
          >
            <span className={cx('app-card__note-type', `app-card__note-type--${latestNote.type}`)}>
              {NOTE_TYPE_LABEL[latestNote.type]}
            </span>
            <span className="app-card__note-text">{latestNote.content}</span>
          </div>
        ) : null}

        <div className="app-card__signals">
          {isEnded ? (
            <span className="badge badge--ended">{STATUS_LABEL[app.status]}</span>
          ) : silence.level ? (
            <span className={cx('badge', silence.level === 'stale' ? 'badge--stale' : 'badge--warn')}>
              {silence.text}
            </span>
          ) : null}

          {suggestion.kind === 'followup' && !silence.level ? (
            <span className="badge badge--quiet">{silence.text || '刚聊过'}</span>
          ) : null}

          {next ? (
            <span className={cx('badge', nextPhase ? 'badge--live' : 'badge--interview')}>
              {nextPhase ||
                `${app.status === 'scheduled' ? '面试 ' : '下一场 '}${relativeCountdown(parseFlexible(next.scheduledAt), now)}`}
            </span>
          ) : null}

          {app.daysPerWeek ? <span className="badge badge--quiet">{app.daysPerWeek} 天/周</span> : null}
          {noteCount > 0 ? <span className="badge badge--quiet">{noteCount} 条记录</span> : null}
        </div>

        <div className="app-card__foot">
          <span className={cx('stars', `stars--${app.priority || 0}`)} title="心动程度">
            {'★★★'.slice(0, app.priority || 0) || '☆☆☆'}
          </span>
          <button
            type="button"
            className="btn btn--tiny"
            onClick={(event) => {
              event.stopPropagation();
              api.openDetail(app.id);
            }}
          >
            {suggestion.label}
          </button>
        </div>

        {menuFor === app.id ? (
          <>
            <div
              className="kebab-backdrop"
              onClick={(event) => {
                event.stopPropagation();
                setMenuFor(null);
              }}
            />
            <div className="kebab-menu" onClick={(event) => event.stopPropagation()}>
              <div className="kebab-menu__title">改状态</div>
              {[...BOARD_COLUMNS, ...ENDED_STATUSES].map((status) => (
                <button
                  key={status}
                  type="button"
                  className={cx('kebab-menu__item', app.status === status && 'is-current')}
                  onClick={() => handleMenuPick(app, status)}
                >
                  <span className="kebab-menu__dot" style={{ background: STATUS_TONE[status] }} />
                  {STATUS_LABEL[status]}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </article>
    );
  };

  return (
    <div className="page page--board">
      <div className="board-head">
        <h2 className="page__title">看板</h2>
        <span className="page__sub">
          共 {totalActive} 条在推进 · {endedCount} 条已结束 · 拖卡片到别的列就能改状态
        </span>
      </div>

      {db.applications.length === 0 ? (
        <div className="empty-block">
          <div className="empty-block__emoji">🗂</div>
          <h2 className="empty-block__title">看板还是空的。</h2>
          <p className="empty-block__text">先去 BOSS 上聊一个，然后回来记一笔 —— 3 秒的事。</p>
          <button type="button" className="btn btn--primary btn--lg" onClick={() => api.openNew()}>
            ＋ 记第一家
          </button>
        </div>
      ) : (
        <div className="board-scroll">
          <div className="board">
            {BOARD_COLUMNS.map((status) => {
              const list = byStatus.get(status) || [];
              return (
                <div
                  key={status}
                  className={cx('board__col', overColumn === status && 'is-over')}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    if (overColumn !== status) setOverColumn(status);
                  }}
                  onDragLeave={(event) => {
                    if (event.currentTarget === event.target) setOverColumn(null);
                  }}
                  onDrop={(event) => handleDrop(event, status)}
                >
                  <div className="board__col-head" style={{ borderTopColor: STATUS_TONE[status] }}>
                    <span className="board__col-name">{STATUS_LABEL[status]}</span>
                    <span className="board__col-head-right">
                      <span className="board__count">{list.length}</span>
                      <button
                        type="button"
                        className="col-add"
                        title={`在「${STATUS_LABEL[status]}」里记一家`}
                        onClick={() => api.openNew(status)}
                      >
                        ＋
                      </button>
                    </span>
                  </div>
                  <div className="board__col-body">
                    {list.map(renderCard)}
                    {list.length === 0 ? <div className="board__empty">拖到这里</div> : null}
                  </div>
                </div>
              );
            })}

            <div className={cx('board__col board__col--ended', endedOpen && 'is-open')}>
              <button
                type="button"
                className="board__col-head board__col-head--clickable"
                onClick={() => setEndedOpen(!endedOpen)}
                style={{ borderTopColor: '#C9CDD8' }}
              >
                <span className="board__col-name">已结束 {endedOpen ? '▾' : '▸'}</span>
                <span className="board__count">{endedCount}</span>
              </button>
              {endedOpen ? (
                <div className="board__col-body">
                  {[...ENDED_STATUSES].flatMap((status) => byStatus.get(status) || []).map(renderCard)}
                  {endedCount === 0 ? <div className="board__empty">还没有结束的</div> : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {dropPanel ? <DropPanel api={api} state={dropPanel} onClose={() => setDropPanel(null)} /> : null}
    </div>
  );
}

/** 渠道 key 的短标签 */
function chLabel(channel: string): string {
  const map: Record<string, string> = {
    boss: 'BOSS',
    shixiseng: '实习僧',
    nowcoder: '牛客',
    referral: '内推',
    official: '官网',
    other: '其他',
  };
  return map[channel] || channel;
}

interface DropPanelProps {
  api: AppApi;
  state: DropPanelState;
  onClose: () => void;
}

/** 拖拽落列后的 3 字段轻面板 —— 全可空，Esc 或点空白直接跳过 */
function DropPanel({ api, state, onClose }: DropPanelProps) {
  const [date, setDate] = useState(() => toDateISO(new Date()));
  const [note, setNote] = useState('');
  const [round, setRound] = useState('');
  const noteRef = useRef<HTMLTextAreaElement | null>(null);

  const submit = (): void => {
    const parts: string[] = [];
    if (round.trim()) parts.push(`第 ${round.trim()} 轮`);
    if (note.trim()) parts.push(note.trim());
    if (parts.length > 0) {
      const at = date ? new Date(`${date}T${new Date().toTimeString().slice(0, 5)}`).toISOString() : undefined;
      api.addNote(state.appId, 'memo', parts.join(' · '), at);
    }
    onClose();
  };

  return (
    <div className="drop-overlay" onClick={onClose}>
      <div
        className="drop-panel"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="drop-panel__head">
          <span>
            已改为 <strong>{STATUS_LABEL[state.to]}</strong>
          </span>
          <button type="button" className="drop-panel__skip" onClick={onClose}>
            跳过 Esc
          </button>
        </div>
        <p className="drop-panel__hint">顺手记一句？不填也没关系，状态已经生效了。</p>
        <div className="drop-panel__row">
          <label className="field field--narrow">
            <span className="field__label">日期</span>
            <input className="input" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
          <label className="field field--narrow">
            <span className="field__label">轮次</span>
            <input
              className="input"
              type="number"
              min={1}
              placeholder="—"
              value={round}
              onChange={(event) => setRound(event.target.value)}
            />
          </label>
        </div>
        <label className="field">
          <span className="field__label">备注</span>
          <textarea
            ref={noteRef}
            className="textarea"
            rows={2}
            autoFocus
            placeholder="例如：HR 说下周安排一面"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
        </label>
        <div className="drop-panel__actions">
          <button type="button" className="btn" onClick={onClose}>
            跳过
          </button>
          <button type="button" className="btn btn--primary" onClick={submit}>
            记下
          </button>
        </div>
      </div>
    </div>
  );
}
