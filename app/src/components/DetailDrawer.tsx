/**
 * 详情抽屉：右侧滑出 480px（小屏 100%）。
 * 分区顺序 = 动作 → 事实 → 历史：概览 / 下一步 / 面试 / 时间线 / 备注。
 * auto:true 的系统条目不可编辑，只显示。
 */

import { useMemo, useState } from 'react';
import type { AppApi } from '../lib/api';
import type { Application, Channel, Interview, InterviewFormat, NoteType, Status } from '../types';
import {
  ALL_STATUSES,
  BOARD_COLUMNS,
  CHANNEL_LABEL,
  CHANNEL_OPTIONS,
  ENDED_STATUSES,
  FORMAT_LABEL,
  JOB_TYPE_LABEL,
  NOTE_TYPE_LABEL,
  REJECT_ROUND_OPTIONS,
  RESULT_LABEL,
  buildFollowupScript,
  deadlineStateOf,
  findConflicts,
  interviewsOf,
  muteRemainDays,
  notesOf,
  rejectedRoundLabel,
  rejectedRoundShort,
  silenceStateOf,
} from '../lib/rules';
import {
  fmtDate,
  fmtDateTime,
  fmtTime,
  fromLocalDateTimeInput,
  toDateISO,
  toLocalDateTimeInput,
} from '../lib/date';
import { experienceForInterview, questionsOf } from '../lib/interview';
import { PLATFORM_LABEL } from '../adapters/registry';
import { copyText, cx, orDash } from '../lib/util';
import { Field, InfoRow, SelectField } from './Field';

export function DetailDrawer({ api }: { api: AppApi }) {
  const app = api.db.applications.find((item) => item.id === api.selectedId);
  if (!app) return null;
  return (
    <div className="drawer-overlay" onClick={api.closeDetail}>
      <aside className="drawer" onClick={(event) => event.stopPropagation()}>
        <DetailBody api={api} app={app} />
      </aside>
    </div>
  );
}

function DetailBody({ api, app }: { api: AppApi; app: Application }) {
  const { db, now } = api;
  const company = db.companies.find((item) => item.id === app.companyId);
  const notes = useMemo(() => notesOf(db.notes, app.id), [db.notes, app.id]);
  const interviews = useMemo(() => interviewsOf(db.interviews, app.id), [db.interviews, app.id]);
  const silence = silenceStateOf(app, db.notes, db.settings, now);
  const deadline = deadlineStateOf(app, db.settings, now);
  const muteLeft = muteRemainDays(app, now);

  const [script, setScript] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [noteType, setNoteType] = useState<NoteType>('chat');
  const [noteText, setNoteText] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  /** 「标为已挂」后弹出的非阻塞轮次选择区 */
  const [rejectPickerOpen, setRejectPickerOpen] = useState(false);

  const nextRound = interviews.length + 1;
  const [formAt, setFormAt] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(15, 0, 0, 0);
    return toLocalDateTimeInput(d.toISOString());
  });
  const [formFormat, setFormFormat] = useState<InterviewFormat>('video');
  const [formRound, setFormRound] = useState(String(nextRound));
  const [formLocation, setFormLocation] = useState('');

  const draftConflicts = useMemo(() => {
    if (!formOpen || !formAt) return [];
    const draft: Interview = {
      id: 'tmp_preview',
      applicationId: app.id,
      round: Number(formRound) || 1,
      scheduledAt: fromLocalDateTimeInput(formAt),
      format: formFormat,
      result: 'pending',
    };
    return findConflicts(draft, db.interviews, db.applications, db.events);
  }, [formOpen, formAt, formRound, formFormat, app.id, db.interviews, db.applications, db.events]);

  const update = (patch: Partial<Application>): void => {
    api.updateApplication(app.id, patch);
  };

  const submitNote = (): void => {
    const text = noteText.trim();
    if (!text) return;
    api.addNote(app.id, noteType, text);
    setNoteText('');
  };

  const handleFollowup = async (): Promise<void> => {
    const text = buildFollowupScript(app, company ? company.name : '贵公司', Math.max(silence.days, 3));
    const ok = await copyText(text);
    setScript(text);
    api.addNote(app.id, 'followup', ok ? '已催一下（话术已复制到剪贴板）' : '已催一下（话术见详情）');
    api.toast(ok ? '话术已复制，沉默计时清零' : '话术已生成，请手动复制');
  };

  /**
   * 静音 N 天：到第 N 天的 23:59:59 为止。
   * 用「当天结束」而不是「现在 + N×24h」—— 用户说「静音 3 天」的意思是
   * 「这三天别再提它」，而不是「72 小时后的这个点才能再提」。
   * 静音只影响软提醒（见 rules.isMuted），硬截止照旧提醒，所以 toast 里要讲明白。
   */
  const muteFor = (days: number): void => {
    const until = new Date(now.getTime());
    until.setDate(until.getDate() + days);
    until.setHours(23, 59, 59, 999);
    update({ mutedUntil: until.toISOString() });
    api.toast(`已静音 ${days} 天，这段时间不催你（硬截止照旧提醒）`);
  };

  const submitInterview = (): void => {
    if (!formAt) return;
    api.addInterview({
      applicationId: app.id,
      round: Number(formRound) || nextRound,
      scheduledAt: fromLocalDateTimeInput(formAt),
      format: formFormat,
      locationOrLink: formLocation.trim() || undefined,
      durationMin: 45,
      result: 'pending',
    });
    if (app.status === 'wishlist' || app.status === 'applied' || app.status === 'chatting') {
      api.changeStatus(app.id, 'scheduled');
    }
    setFormOpen(false);
    setFormLocation('');
    api.toast(draftConflicts.length > 0 ? '面试已加，但存在时间冲突，已标在日历上' : '面试已加入日历');
  };

  return (
    <>
      <header className="drawer__head">
        <div className="drawer__title-wrap">
          <h2 className="drawer__title">
            {company ? company.name : '未知公司'} · {app.jobTitle}
          </h2>
          <div className="drawer__chips">
            <span className="chip chip--status">{statusLabelOf(app.status)}</span>
            {silence.level ? (
              <span className={cx('chip', silence.level === 'stale' ? 'chip--red' : 'chip--amber')}>
                {silence.text}
              </span>
            ) : null}
            {deadline.level === 'overdue' || deadline.level === 'today' ? (
              <span className="chip chip--red">{deadline.text}</span>
            ) : deadline.level === 'soon' ? (
              <span className="chip chip--amber">{deadline.text}</span>
            ) : deadline.days !== null ? (
              <span className="chip chip--quiet">{deadline.text}</span>
            ) : null}
            {muteLeft !== null ? (
              <button
                type="button"
                className="chip chip--quiet"
                title="点这里立刻取消静音"
                onClick={() => {
                  update({ mutedUntil: null });
                  api.toast('已取消静音');
                }}
              >
                静音中 · 还剩 {muteLeft} 天
              </button>
            ) : null}
            {app.priority ? <span className="chip chip--quiet">{'★'.repeat(app.priority)}</span> : null}
            {app.status === 'rejected' ? (
              <button
                type="button"
                className={cx('chip', app.rejectedAtRound ? 'chip--quiet' : 'chip--amber')}
                title="点这里补录挂在哪一轮"
                onClick={() => setRejectPickerOpen(true)}
              >
                {rejectedRoundShort(app.rejectedAtRound)}
              </button>
            ) : null}
          </div>
          {/*
            来源行：只在这条投递被同步写过时才出现。
            刻意分三段说清三件事：谁写的（平台）、什么时候写的（心跳）、凭什么写的（平台原文状态）。
            「上次同步」用 lastSyncedAt 而不是 lastContactAt —— 后者是平台业务时间，不参与沉默，
            但用户看到「上次同步」时想知道的正是「我多久没抓这个平台了」。
          */}
          {app.sync ? (
            <p className="drawer__source">
              <span>来源：{PLATFORM_LABEL[app.sync.platform]} 同步</span>
              {app.sync.lastSyncedAt ? <span> · {fmtDateTime(app.sync.lastSyncedAt)}</span> : null}
              {app.sync.platformStatusRaw ? (
                <span className="drawer__source-raw" title="平台原文，不改写、不翻译，方便你核对映射">
                  {' '}
                  · 平台原文「{app.sync.platformStatusRaw}」
                </span>
              ) : null}
            </p>
          ) : null}
        </div>
        <button type="button" className="icon-btn" onClick={api.closeDetail} title="关闭（Esc）">
          ✕
        </button>
      </header>

      <div className="drawer__body">
        {/* ---------------- 下一步（第一屏必须是行动） ---------------- */}
        <section className="drawer__section">
          <h3 className="drawer__section-title">下一步</h3>
          <div className="drawer__actions">
            <button type="button" className="btn btn--primary btn--small" onClick={() => void handleFollowup()}>
              去催一下
            </button>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => {
                setNoteType('chat');
                document.getElementById('quick-note')?.focus();
              }}
            >
              记一条沟通
            </button>
            <button type="button" className="btn btn--small" onClick={() => setFormOpen(true)}>
              约面试
            </button>
            <button
              type="button"
              className="btn btn--small btn--danger-ghost"
              onClick={() => {
                api.changeStatus(app.id, 'rejected');
                // 状态先落库，再非阻塞地递上一个「挂在哪一轮」的小选择区，绝不拦人
                setRejectPickerOpen(true);
                api.toast('已标为已挂，顺手选一下挂在哪一轮？不选也行');
              }}
            >
              标为已挂
            </button>
          </div>
          {rejectPickerOpen ? (
            <RejectRoundPicker
              value={app.rejectedAtRound}
              onPick={(value) => update({ rejectedAtRound: value })}
              onSkip={() => setRejectPickerOpen(false)}
            />
          ) : null}
          {script ? (
            <div className="script-box">
              <div className="script-box__head">
                <span>可以直接复制给 HR：</span>
                <button type="button" className="link-btn" onClick={() => setScript(null)}>
                  收起
                </button>
              </div>
              <textarea className="textarea" rows={3} readOnly value={script} />
            </div>
          ) : null}
          <div className="drawer__row">
            <SelectField<Status>
              label="改状态"
              value={app.status}
              options={ALL_STATUSES.map((status) => ({ value: status, label: statusLabelOf(status) }))}
              onChange={(value) => api.changeStatus(app.id, value)}
            />
            <Field
              label="下次动作（自己定）"
              type="date"
              value={app.nextActionAt || ''}
              onCommit={(value) => update({ nextActionAt: value || null })}
              narrow
            />
          </div>
          <div className="drawer__row">
            <Field
              label="截止日期"
              type="date"
              value={app.deadlineAt || ''}
              onCommit={(value) => update({ deadlineAt: value || undefined })}
              hint={
                deadline.days !== null
                  ? deadline.text
                  : '投递截止、Offer 回复截止都记这里；留空 = 不跟截止'
              }
              narrow
            />
            <div className="field field--narrow">
              <span className="field__label">暂时别催</span>
              <div className="drawer__actions">
                <button type="button" className="btn btn--tiny" onClick={() => muteFor(3)}>
                  3 天
                </button>
                <button type="button" className="btn btn--tiny" onClick={() => muteFor(7)}>
                  7 天
                </button>
                {muteLeft !== null ? (
                  <button
                    type="button"
                    className="btn btn--tiny"
                    onClick={() => {
                      update({ mutedUntil: null });
                      api.toast('已取消静音');
                    }}
                  >
                    取消
                  </button>
                ) : null}
              </div>
              <span className="field__hint">静音只停软提醒，截止照旧提醒</span>
            </div>
          </div>
        </section>

        {/* ---------------- 概览 ---------------- */}
        <section className="drawer__section">
          <h3 className="drawer__section-title">概览</h3>
          <InfoRow label="投递日" value={app.appliedAt ? fmtDate(app.appliedAt) : '还没投'} />
          <InfoRow label="状态变更" value={fmtDateTime(app.statusChangedAt)} />
          <InfoRow label="最近互动" value={fmtDateTime(app.lastActivityAt)} />
          <div className="drawer__grid">
            <Field label="岗位名" value={app.jobTitle} onCommit={(value) => update({ jobTitle: value.trim() || app.jobTitle })} />
            <Field label="城市" value={app.city || ''} onCommit={(value) => update({ city: value.trim() || undefined })} placeholder="北京" narrow />
            <SelectField<Channel>
              label="渠道"
              value={(app.channel || '') as Channel | ''}
              placeholder="未标注"
              options={CHANNEL_OPTIONS.map((channel) => ({ value: channel, label: CHANNEL_LABEL[channel] }))}
              onChange={(value) => update({ channel: value })}
              narrow
            />
            <SelectField<'daily' | 'summer' | 'fulltime'>
              label="实习类型"
              value={app.jobType || 'daily'}
              options={(['daily', 'summer', 'fulltime'] as const).map((type) => ({
                value: type,
                label: JOB_TYPE_LABEL[type],
              }))}
              onChange={(value) => update({ jobType: value })}
              narrow
            />
            <Field
              label="投递日期"
              type="date"
              value={app.appliedAt || ''}
              onCommit={(value) => update({ appliedAt: value || undefined })}
              narrow
            />
            <Field
              label="简历版本"
              value={app.resumeVersion || ''}
              onCommit={(value) => update({ resumeVersion: value.trim() || undefined })}
              placeholder={db.settings.defaultResumeVersion || 'v3-前端-项目版'}
            />
            <Field label="薪资原文" value={app.salaryText || ''} onCommit={(value) => update({ salaryText: value.trim() || undefined })} placeholder="200-300/天" narrow />
            <Field
              label="每周到岗（天）"
              type="number"
              min={1}
              max={7}
              value={app.daysPerWeek ? String(app.daysPerWeek) : ''}
              onCommit={(value) => {
                const n = Number(value);
                update({ daysPerWeek: Number.isFinite(n) && n > 0 ? n : undefined });
              }}
              narrow
            />
            <Field
              label="可实习（月）"
              type="number"
              min={1}
              value={app.durationMonths ? String(app.durationMonths) : ''}
              onCommit={(value) => {
                const n = Number(value);
                update({ durationMonths: Number.isFinite(n) && n > 0 ? n : undefined });
              }}
              narrow
            />
            <Field
              label="沉默阈值覆盖（天）"
              type="number"
              min={1}
              value={app.silenceOverride ? String(app.silenceOverride) : ''}
              onCommit={(value) => {
                const n = Number(value);
                update({ silenceOverride: Number.isFinite(n) && n > 0 ? n : null });
              }}
              hint="填了就是绝对阈值（不再乘渠道系数）；留空 = 全局阈值 × 渠道系数；最小生效 1 天，填 1 会当天标红"
              narrow
            />
            <Field label="JD 链接" type="url" value={app.jdUrl || ''} onCommit={(value) => update({ jdUrl: value.trim() || undefined })} placeholder="https://" />
            <Field
              label="内推人 / 介绍人"
              value={company?.referrer || ''}
              onCommit={(value) => company && api.updateCompany(company.id, { referrer: value.trim() || undefined })}
              narrow
            />
          </div>
          <Field
            label="公司印象 / 面试风格"
            value={company?.impression || ''}
            onCommit={(value) => company && api.updateCompany(company.id, { impression: value.trim() || undefined })}
            placeholder="例如：面试官偏八股，节奏快"
          />
          <div className="drawer__row">
            <label className="field field--narrow">
              <span className="field__label">心动程度</span>
              <div className="stars-input">
                {[1, 2, 3].map((level) => (
                  <button
                    key={level}
                    type="button"
                    className={cx('star-btn', (app.priority || 0) >= level && 'is-on')}
                    onClick={() =>
                      update({ priority: (app.priority === level ? undefined : level) as 1 | 2 | 3 | undefined })
                    }
                  >
                    ★
                  </button>
                ))}
              </div>
            </label>
            {app.status === 'rejected' ? (
              <>
                <div className="reject-block">
                  <div className="reject-block__head">
                    <span className="field__label">挂在哪一轮</span>
                    {app.rejectedAtRound === null || app.rejectedAtRound === undefined ? (
                      <button type="button" className="link-btn" onClick={() => setRejectPickerOpen(true)}>
                        轮次未记 · 点这里补录
                      </button>
                    ) : (
                      <span className="chip chip--quiet">{rejectedRoundLabel(app.rejectedAtRound)}</span>
                    )}
                  </div>
                  <div className="reject-picker__chips">
                    {REJECT_ROUND_OPTIONS.map((option) => {
                      // 只有「明确选了某个轮次」才高亮：null 既可能是"没选"也可能是"选了不记得"，
                      // 数据层无法区分，所以这里一律不高亮「不记得了」，避免误以为已选过。
                      const active = option.value !== null && app.rejectedAtRound === option.value;
                      return (
                        <button
                          key={String(option.value)}
                          type="button"
                          className={cx('chip-toggle', active && 'is-active')}
                          onClick={() => update({ rejectedAtRound: option.value })}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <Field
                  label="其他轮次（可留空）"
                  type="number"
                  min={1}
                  value={app.rejectedAtRound ? String(app.rejectedAtRound) : ''}
                  onCommit={(value) => {
                    const n = Number(value);
                    update({ rejectedAtRound: Number.isFinite(n) && n > 0 ? n : null });
                  }}
                  hint="HR 面记作第 4 轮"
                  narrow
                />
                <Field
                  label="挂的原因"
                  value={app.rejectReason || ''}
                  onCommit={(value) => update({ rejectReason: value.trim() || undefined })}
                  placeholder="手写 Promise 没写出来"
                />
              </>
            ) : null}
          </div>
        </section>

        {/* ---------------- 面试 ---------------- */}
        <section className="drawer__section">
          <div className="drawer__section-head">
            <h3 className="drawer__section-title">面试（{interviews.length}）</h3>
            <button type="button" className="link-btn" onClick={() => setFormOpen(!formOpen)}>
              {formOpen ? '收起' : '＋ 加一场'}
            </button>
          </div>

          {formOpen ? (
            <div className="interview-form">
              <div className="drawer__row">
                <label className="field">
                  <span className="field__label">时间</span>
                  <input
                    className="input"
                    type="datetime-local"
                    value={formAt}
                    onChange={(event) => setFormAt(event.target.value)}
                  />
                </label>
                <label className="field field--narrow">
                  <span className="field__label">轮次</span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={formRound}
                    onChange={(event) => setFormRound(event.target.value)}
                  />
                </label>
                <label className="field field--narrow">
                  <span className="field__label">形式</span>
                  <select
                    className="select"
                    value={formFormat}
                    onChange={(event) => setFormFormat(event.target.value as InterviewFormat)}
                  >
                    {(['video', 'onsite', 'phone'] as const).map((format) => (
                      <option key={format} value={format}>
                        {FORMAT_LABEL[format]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <Field
                label="地点 / 会议链接"
                value={formLocation}
                onCommit={setFormLocation}
                placeholder="飞书会议 / 杭州西溪园区 A 座"
              />
              {draftConflicts.length > 0 ? (
                <div className="notice notice--warn">
                  <strong>⚠ 时间冲突</strong>
                  {draftConflicts.map((message) => (
                    <p key={message}>{message}</p>
                  ))}
                  <p className="notice__foot">只是提醒，仍然可以保存。</p>
                </div>
              ) : null}
              <div className="drawer__row">
                <button type="button" className="btn btn--primary btn--small" onClick={submitInterview}>
                  保存面试
                </button>
                <button type="button" className="btn btn--small" onClick={() => setFormOpen(false)}>
                  取消
                </button>
              </div>
            </div>
          ) : null}

          {interviews.length === 0 ? (
            <p className="muted">还没有面试记录。约上了就记一条，日历会自动标出来。</p>
          ) : (
            <ul className="iv-list">
              {interviews.map((interview) => (
                <InterviewCard key={interview.id} api={api} interview={interview} />
              ))}
            </ul>
          )}
        </section>

        {/* ---------------- 时间线 ---------------- */}
        <section className="drawer__section">
          <div className="drawer__section-head">
            <h3 className="drawer__section-title">时间线（{notes.length}）</h3>
            <span className="card__hint">记一条，红色沉默就消失了</span>
          </div>

          <div className="quick-note">
            <div className="quick-note__types">
              {(['chat', 'followup', 'memo'] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  className={cx('chip-toggle', noteType === type && 'is-active')}
                  onClick={() => setNoteType(type)}
                >
                  {NOTE_TYPE_LABEL[type]}
                </button>
              ))}
            </div>
            <textarea
              id="quick-note"
              className="textarea"
              rows={2}
              value={noteText}
              placeholder="Enter 提交 / Shift+Enter 换行"
              onChange={(event) => setNoteText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submitNote();
                }
              }}
            />
            <div className="quick-note__foot">
              <button
                type="button"
                className="btn btn--primary btn--small"
                onClick={submitNote}
                disabled={noteText.trim().length === 0}
              >
                记一条
              </button>
            </div>
          </div>

          {notes.length === 0 ? (
            <p className="muted">还没有任何记录。第一次沟通、第一句「已读」，都值得记下来。</p>
          ) : (
            <ol className="timeline">
              {notes.map((note) => (
                <li key={note.id} className={cx('timeline__item', note.auto && 'is-auto')}>
                  <span className={cx('timeline__dot', `timeline__dot--${note.type}`)} />
                  <div className="timeline__body">
                    <div className="timeline__meta">
                      <span className="timeline__badge">
                        {note.auto ? '系统' : NOTE_TYPE_LABEL[note.type]}
                      </span>
                      <span className="timeline__time">{fmtDateTime(note.touchedAt)}</span>
                      {note.auto ? null : (
                        <button
                          type="button"
                          className="link-btn link-btn--danger"
                          onClick={() => {
                            api.deleteNote(note.id);
                            api.toast('已删除这条记录');
                          }}
                        >
                          删除
                        </button>
                      )}
                    </div>
                    <p className="timeline__content">{note.content}</p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        {/* ---------------- 底部：删除 ---------------- */}
        <section className="drawer__section drawer__section--danger">
          {confirmDelete ? (
            <div className="notice notice--danger">
              删掉「{app.jobTitle}」这条投递？时间线和面试记录会一起消失，不能撤销。
              <div className="drawer__row">
                <button
                  type="button"
                  className="btn btn--small btn--danger"
                  onClick={() => {
                    api.deleteApplication(app.id);
                    api.closeDetail();
                  }}
                >
                  确认删除
                </button>
                <button type="button" className="btn btn--small" onClick={() => setConfirmDelete(false)}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn btn--small btn--danger-ghost" onClick={() => setConfirmDelete(true)}>
              删除这条投递
            </button>
          )}
          <p className="drawer__foot">
            创建于 {fmtDate(app.createdAt)} · ID {app.id}
          </p>
        </section>
      </div>
    </>
  );
}

/**
 * 「挂在哪一轮」的非阻塞快选。
 * 状态已经落库了，这里只是把复盘最有价值的那一栏顺手补齐：
 * 选完立即写入，不选/点「先不记」也完全不影响已保存的状态。
 */
function RejectRoundPicker({
  value,
  onPick,
  onSkip,
}: {
  value: number | null | undefined;
  onPick: (value: number | null) => void;
  onSkip: () => void;
}) {
  const current = value ?? null;
  /** 用户这次显式点了「不记得了」才把那个 chip 点亮 —— 存进库里的 null 无法区分"没选"和"选了不记得" */
  const [pickedUnknown, setPickedUnknown] = useState(false);
  const isActive = (optionValue: number | null): boolean => {
    if (optionValue === null) return pickedUnknown && current === null;
    return current === optionValue;
  };
  return (
    <div className="reject-picker">
      <div className="reject-picker__head">
        <span>
          挂在哪一轮？<span className="reject-picker__opt">（选填，不选也能保存）</span>
        </span>
        <button type="button" className="link-btn" onClick={onSkip}>
          先不记
        </button>
      </div>
      <div className="reject-picker__chips">
        {REJECT_ROUND_OPTIONS.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            className={cx('chip-toggle', isActive(option.value) && 'is-active')}
            onClick={() => {
              if (option.value === null) setPickedUnknown(true);
              onPick(option.value);
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="reject-picker__hint">
        {current === null ? '现在是「轮次未记」—— 想起来了随时在概览里补。' : `已记为「${rejectedRoundLabel(current)}」。`}
      </p>
    </div>
  );
}

function statusLabelOf(status: Status): string {
  const index = [...BOARD_COLUMNS, ...ENDED_STATUSES].indexOf(status);
  const labels: Record<Status, string> = {
    wishlist: '想投',
    applied: '已投递',
    chatting: '已沟通',
    scheduled: '已约面',
    interviewing: '面试中',
    offer: '已发 Offer',
    onboarded: '已入职',
    rejected: '已挂',
    dropped: '已放弃',
  };
  return index >= 0 ? labels[status] : orDash(status);
}

/** 单场面试卡片：结果、准备清单、备注、删除 */function InterviewCard({ api, interview }: { api: AppApi; interview: Interview }) {
  const { db } = api;
  const conflicts = useMemo(
    () => findConflicts(interview, db.interviews, db.applications, db.events),
    [interview, db.interviews, db.applications, db.events],
  );
  const checklist = interview.prepChecklist || [];
  const doneCount = checklist.filter((item) => item.done).length;
  const [newItem, setNewItem] = useState('');

  // v0.2：这场比赛记过面经吗？记过就显示题数，没记过就显示入口
  const app = db.applications.find((item) => item.id === interview.applicationId);
  const company = app ? db.companies.find((item) => item.id === app.companyId) : undefined;
  const existingExperience = experienceForInterview(db.experiences, interview.applicationId, interview.round);
  const experienceQuestionCount = existingExperience
    ? questionsOf(db.questions, existingExperience.id).length
    : 0;

  const patch = (value: Partial<Interview>): void => api.updateInterview(interview.id, value);

  const togglePrep = (id: string): void => {
    patch({
      prepChecklist: checklist.map((item) => (item.id === id ? { ...item, done: !item.done } : item)),
    });
  };

  const addPrep = (): void => {
    const text = newItem.trim();
    if (!text) return;
    patch({
      prepChecklist: [
        ...checklist,
        { id: `p_${Date.now().toString(36)}`, text, done: false },
      ],
    });
    setNewItem('');
  };

  return (
    <li className="iv-card">
      <div className="iv-card__head">
        <span className="iv-card__round">第 {interview.round} 轮</span>
        <span className="iv-card__time">{fmtDateTime(interview.scheduledAt)}</span>
        <span className="iv-card__format">{FORMAT_LABEL[interview.format]}</span>
      </div>
      <div className="iv-card__meta">
        {interview.locationOrLink ? <span>{interview.locationOrLink}</span> : null}
        {interview.interviewer ? <span>面试官：{interview.interviewer}</span> : null}
        {interview.durationMin ? <span>{interview.durationMin} 分钟</span> : null}
      </div>

      {conflicts.length > 0 ? (
        <div className="notice notice--warn notice--inline">
          <strong>⚠ 时间冲突</strong>
          {conflicts.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}

      <div className="drawer__row">
        <label className="field field--narrow">
          <span className="field__label">结果</span>
          <select
            className="select"
            value={interview.result}
            onChange={(event) => patch({ result: event.target.value as Interview['result'] })}
          >
            {(['pending', 'passed', 'failed', 'cancelled'] as const).map((result) => (
              <option key={result} value={result}>
                {RESULT_LABEL[result]}
              </option>
            ))}
          </select>
        </label>
        <Field
          label="面完的感受 / 被问了什么"
          value={interview.notes || ''}
          onCommit={(value) => patch({ notes: value.trim() || undefined })}
          placeholder="问了事件循环、手写防抖……"
        />
      </div>

      <div className="iv-card__exp">
        {existingExperience ? (
          <>
            <button
              type="button"
              className="link-btn"
              onClick={() => api.openExperience(existingExperience.id)}
            >
              已有 {experienceQuestionCount} 题 ▸
            </button>
            <span className="muted">继续补「我当时怎么答的」</span>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn--small"
              onClick={() =>
                api.openQuickNote({
                  applicationId: interview.applicationId,
                  companyName: company?.shortName || company?.name || '未知公司',
                  jobTitle: app?.jobTitle,
                  round: interview.round,
                  interviewDate: toDateISO(new Date(interview.scheduledAt)),
                })
              }
            >
              记面经
            </button>
            <span className="muted">一行一题，面完趁热记</span>
          </>
        )}
      </div>

      <div className="iv-card__prep">
        <div className="iv-card__prep-head">
          准备清单 {doneCount}/{checklist.length}
        </div>
        <ul className="prep-list">
          {checklist.map((item) => (
            <li key={item.id} className={cx('prep-item', item.done && 'is-done')}>
              <label>
                <input type="checkbox" checked={item.done} onChange={() => togglePrep(item.id)} />
                <span>{item.text}</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="prep-add">
          <input
            className="input input--compact"
            value={newItem}
            placeholder="＋ 加一条准备项"
            onChange={(event) => setNewItem(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addPrep();
              }
            }}
          />
        </div>
      </div>

      <div className="iv-card__foot">
        <span className="muted">{fmtTime(interview.scheduledAt)} 开始</span>
        <button
          type="button"
          className="link-btn link-btn--danger"
          onClick={() => {
            api.deleteInterview(interview.id);
            api.toast('已删除这场面试');
          }}
        >
          删除这场面试
        </button>
      </div>
    </li>
  );
}
