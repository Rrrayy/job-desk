/**
 * 看板：横向 7 列 + 右侧可折叠「已结束」列。
 * 拖拽落列即改状态；落列后弹一个轻面板（日期 / 轮次 / 类型 / 备注），
 * 面试段三列（已笔试/已约面/面试中）落列时写**结构化 Interview 行**（v0.8 F8 修复），
 * Esc 或点空白即跳过，但状态照常生效。卡片右上角「⋯」是拖拽不可用时的兜底。
 * 面试段三列可一键收纳成计数 chip（默认展开，本地 state，不落库）。
 */

import { useMemo, useRef, useState } from 'react';
import type { AppApi } from '../lib/api';
import type { Application, InterviewKind, Status } from '../types';
import {
  BOARD_COLUMNS,
  ENDED_STATUSES,
  NOTE_TYPE_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  buildNoteIndex,
  currentRoundOf,
  interviewKindLabel,
  interviewPhaseLabel,
  latestUserNoteOf,
  nextInterviewOf,
  roundBadgeText,
  silenceStateOf,
  suggestionFor,
} from '../lib/rules';
import { parseFlexible, relativeCountdown, toDateISO } from '../lib/date';
import { boardWindow, moreCardsLabel } from '../lib/boardWindow';
import { companyLabel, cx } from '../lib/util';
import { CLS } from '../lib/classTokens';

interface DropPanelState {
  appId: string;
  from: Status;
  to: Status;
}

/** 面试段三列：一键收纳的范围（PRD §4.3） */
const STAGE_COLUMNS: Status[] = ['written', 'scheduled', 'interviewing'];

export function BoardView({ api }: { api: AppApi }) {
  const { db, now } = api;
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<Status | null>(null);
  const [endedOpen, setEndedOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dropPanel, setDropPanel] = useState<DropPanelState | null>(null);
  /** v0.8：面试段三列收纳（默认展开；本地 state，不落库 —— 刷新即恢复展开） */
  const [stageFolded, setStageFolded] = useState(false);
  /**
   * v0.9.1 / B-11：哪些列点过「还有 N 家」而展开（key = status 或 'ended'）。
   * 不落库：刷新回到默认窗口是一件好事（看板要的是「一眼看清分布」）。
   */
  const [expandedCols, setExpandedCols] = useState<Record<string, boolean>>({});
  const expandCol = (key: string): void => setExpandedCols((prev) => ({ ...prev, [key]: true }));

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
  /** v0.9.1 / B-11：已结束列也用同一套窗口（key = 'ended'），计数仍是真实总数 */
  const endedWin = boardWindow(
    ENDED_STATUSES.flatMap((status) => byStatus.get(status) || []),
    expandedCols.ended === true,
  );

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
    // v0.8：轮次徽章（第 N 轮 · 类型）。只在「已约面 / 面试中」两列出现；
    // 「已笔试」列的笔试安排由下面的 next 徽章负责倒计时，避免重复。
    const roundBadge =
      app.status === 'scheduled' || app.status === 'interviewing'
        ? roundBadgeText(currentRoundOf(app, db.interviews))
        : '';

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
            <span className={CLS.at}>{silence.text || '刚聊过'}</span>
          ) : null}

          {roundBadge ? <span className="badge badge--round">{roundBadge}</span> : null}

          {next ? (
            <span className={cx('badge', nextPhase ? 'badge--live' : 'badge--interview')}>
              {nextPhase ||
                `${app.status === 'scheduled' ? '面试 ' : '下一场 '}${relativeCountdown(parseFlexible(next.scheduledAt), now)}`}
            </span>
          ) : null}

          {app.daysPerWeek ? <span className={CLS.at}>{app.daysPerWeek} 天/周</span> : null}
          {noteCount > 0 ? <span className={CLS.at}>{noteCount} 条记录</span> : null}
        </div>

        <div className="app-card__foot">
          <span className={cx('stars', `stars--${app.priority || 0}`)} title="心动程度">
            {'★★★'.slice(0, app.priority || 0) || '☆☆☆'}
          </span>
          <button
            type="button"
            className={CLS.h}
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
      <div className={CLS.ao}>
        <h2 className={CLS.am}>看板</h2>
        <span className={CLS.ad}>
          共 {totalActive} 条在推进 · {endedCount} 条已结束 · 拖卡片到别的列就能改状态
        </span>
        <button
          type="button"
          className="btn btn--tiny board-fold-toggle"
          title="把「已笔试 / 已约面 / 面试中」三列收成计数，一屏更清爽"
          onClick={() => setStageFolded(!stageFolded)}
        >
          {stageFolded ? '展开面试段 ▸' : '收纳面试段 ▸'}
        </button>
      </div>

      {db.applications.length === 0 ? (
        <div className={CLS.C}>
          <div className={CLS.y}>🗂</div>
          <h2 className={CLS.z}>看板还是空的。</h2>
          <p className={CLS.A}>先去 BOSS 上聊一个，然后回来记一笔 —— 3 秒的事。</p>
          <button type="button" className={CLS.W} onClick={() => api.openNew()}>
            ＋ 记第一家
          </button>
        </div>
      ) : (
        <div className="board-scroll">
          <div className="board">
            {BOARD_COLUMNS.map((status) => {
              const list = byStatus.get(status) || [];
              // v0.9.1 / B-11：每列最多渲染 40 张；**列头计数永远用 win.total**
              const win = boardWindow(list, expandedCols[status] === true);
              const folded = stageFolded && STAGE_COLUMNS.includes(status);
              return (
                <div
                  key={status}
                  className={cx('board__col', overColumn === status && 'is-over', folded && 'board__col--folded')}
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
                  {folded ? (
                    // 折叠态：只剩可点击的列头（名称 + 计数）。仍是独立的拖拽落点，
                    // 拖到「已约面」的折叠 chip 上落的就是「已约面」，不会串列。
                    <button
                      type="button"
                      className={CLS.aR}
                      title="点击展开面试段"
                      onClick={() => setStageFolded(false)}
                      style={{ borderTopColor: STATUS_TONE[status] }}
                    >
                      <span className={CLS.aB}>{STATUS_LABEL[status]} ▸</span>
                      <span className={CLS.aP}>{win.total}</span>
                    </button>
                  ) : (
                    <>
                      <div className="board__col-head" style={{ borderTopColor: STATUS_TONE[status] }}>
                        <span className={CLS.aB}>{STATUS_LABEL[status]}</span>
                        <span className="board__col-head-right">
                          <span className={CLS.aP}>{win.total}</span>
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
                        {win.visible.map(renderCard)}
                        {win.hidden > 0 ? (
                          <button
                            type="button"
                            className="board__more"
                            data-testid={`board-more-${status}`}
                            onClick={() => expandCol(status)}
                          >
                            {moreCardsLabel(win.hidden)}
                          </button>
                        ) : null}
                        {win.total === 0 ? <div className="board__empty">拖到这里</div> : null}
                      </div>
                    </>
                  )}
                </div>
              );
            })}

            <div className={cx('board__col board__col--ended', endedOpen && 'is-open')}>
              <button
                type="button"
                className={CLS.aR}
                onClick={() => setEndedOpen(!endedOpen)}
                style={{ borderTopColor: '#C9CDD8' }}
              >
                <span className={CLS.aB}>已结束 {endedOpen ? '▾' : '▸'}</span>
                <span className={CLS.aP}>{endedWin.total}</span>
              </button>
              {endedOpen ? (
                <div className="board__col-body">
                  {endedWin.visible.map(renderCard)}
                  {endedWin.hidden > 0 ? (
                    <button
                      type="button"
                      className="board__more"
                      data-testid="board-more-ended"
                      onClick={() => expandCol('ended')}
                    >
                      {moreCardsLabel(endedWin.hidden)}
                    </button>
                  ) : null}
                  {endedWin.total === 0 ? <div className="board__empty">还没有结束的</div> : null}
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

/**
 * 拖拽落列后的轻面板 —— 全可空，Esc 或点空白直接跳过。
 *
 * v0.8（F8 修复）：落「已笔试 / 已约面 / 面试中」时，轮次与类型不再拼成一条
 * memo 字符串，而是写**结构化 Interview 行**（round/kind/scheduledAt），
 * 走既有 addInterview mutate 通道；备注仍然落时间线。笔试固定 round=0。
 */
function DropPanel({ api, state, onClose }: DropPanelProps) {
  const { db } = api;
  const app = db.applications.find((item) => item.id === state.appId);
  const existingRounds = app
    ? db.interviews.filter((item) => item.applicationId === app.id)
    : [];
  const nextRound = existingRounds.length + 1;
  const isInterviewStage = STAGE_COLUMNS.includes(state.to);
  const isWritten = state.to === 'written';

  const [date, setDate] = useState(() => toDateISO(new Date()));
  const [note, setNote] = useState('');
  const [round, setRound] = useState(isWritten ? '0' : String(nextRound));
  const [kind, setKind] = useState<InterviewKind | ''>(isWritten ? 'written' : '');
  const noteRef = useRef<HTMLTextAreaElement | null>(null);

  const submit = (): void => {
    // 面试 / 笔试记录统一挂当天 09:00（面板只有日期没有时刻；详情抽屉里可改）
    const at = date ? new Date(`${date}T09:00`).toISOString() : undefined;
    if (isInterviewStage) {
      const parsed = Number(round);
      api.addInterview({
        applicationId: state.appId,
        round: isWritten
          ? 0
          : Number.isFinite(parsed) && parsed >= 1
            ? Math.round(parsed)
            : nextRound,
        scheduledAt: at || new Date().toISOString(),
        format: 'video',
        ...(kind ? { kind } : {}),
        result: 'pending',
      });
    }
    if (note.trim()) {
      api.addNote(state.appId, 'memo', note.trim(), at);
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
        <p className="drop-panel__hint">
          {isInterviewStage
            ? '顺手记下轮次和类型？会写成一条结构化面试/笔试记录，日历和徽章都能用。'
            : '顺手记一句？不填也没关系，状态已经生效了。'}
        </p>
        <div className="drop-panel__row">
          <label className={CLS.e}>
            <span className={CLS.a}>日期</span>
            <input className={CLS.f} type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
          {isInterviewStage ? (
            <label className={CLS.e}>
              <span className={CLS.a}>轮次{isWritten ? '（笔试固定第 0 轮）' : ''}</span>
              <input
                className={CLS.f}
                type="number"
                min={isWritten ? 0 : 1}
                disabled={isWritten}
                placeholder="—"
                value={round}
                onChange={(event) => setRound(event.target.value)}
              />
            </label>
          ) : null}
        </div>
        {isInterviewStage && !isWritten ? (
          <label className={CLS.e}>
            <span className={CLS.a}>类型</span>
            <select
              className={CLS.D}
              value={kind}
              onChange={(event) => setKind(event.target.value as InterviewKind | '')}
            >
              <option value="">未标注</option>
              {(['tech', 'hr', 'cross', 'group', 'director', 'other'] as const).map((item) => (
                <option key={item} value={item}>
                  {interviewKindLabel(item)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className={CLS.g}>
          <span className={CLS.a}>备注</span>
          <textarea
            ref={noteRef}
            className={CLS.T}
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
          <button type="button" className={CLS.j} onClick={submit}>
            记下
          </button>
        </div>
      </div>
    </div>
  );
}
