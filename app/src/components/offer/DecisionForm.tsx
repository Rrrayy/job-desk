/**
 * 模块一 · 决策表单（OFF-8）。
 *
 * 一条硬约束：**记录选择 ≠ 已经拒了别人**。所以这里只写 `db.offerDecision`，
 * 一个 Application 字段都不碰 —— 自动改状态会在用户还没通知 HR 时就把管线画成完成态。
 *
 * 另一条：改选即覆盖，但**必须二次确认**（D-05：App 层只信「调用方已确认」）。
 */

import { useState } from 'react';
import type { AppApi } from '../../lib/api';
import type { OfferCandidate } from '../../lib/offer/compare';
import {
  DECISION_NOTE_LIMIT,
  DECISION_TAG_CHAR_LIMIT,
  DECISION_TAG_LIMIT,
  REASON_TAG_PRESETS,
  type DecisionView,
} from '../../lib/offer/decision';
import { todayISO } from '../../lib/date';
import { cx } from '../../lib/util';
import { CLS } from '../../lib/classTokens';

export interface DecisionFormProps {
  api: AppApi;
  candidates: OfferCandidate[];
  /** App 层算好的视图（悬空时 companyLabel 已兜底成「（投递已删除）」） */
  view: DecisionView | null;
}

export function DecisionForm({ api, candidates, view }: DecisionFormProps) {
  const existing = view?.decision ?? null;
  const [open, setOpen] = useState(false);
  const [chosenId, setChosenId] = useState<string>(existing?.applicationId ?? '');
  const [decidedAt, setDecidedAt] = useState<string>(existing?.decidedAt ?? todayISO(api.now));
  const [tags, setTags] = useState<string[]>(existing?.reasonTags ?? []);
  const [note, setNote] = useState<string>(existing?.note ?? '');
  const [declined, setDeclined] = useState<string[]>(existing?.declinedIds ?? []);
  /** 已有决策时再保存 = 覆盖，先点一次「确认改选」 */
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);

  const labelOf = (id: string): string => {
    const item = candidates.find((candidate) => candidate.app.id === id);
    if (!item) return '（这条投递不在了）';
    const company = item.company ? item.company.shortName || item.company.name : '未知公司';
    return `${company} · ${item.app.jobTitle}`;
  };

  const toggleTag = (label: string): void => {
    setTags((prev) =>
      prev.includes(label)
        ? prev.filter((item) => item !== label)
        : prev.length >= DECISION_TAG_LIMIT
          ? prev
          : [...prev, label.slice(0, DECISION_TAG_CHAR_LIMIT)],
    );
  };

  const toggleDeclined = (id: string): void => {
    setDeclined((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const canSave = chosenId.length > 0;

  const save = (): void => {
    if (!canSave) return;
    if (existing && !confirmOverwrite) {
      setConfirmOverwrite(true);
      return;
    }
    api.offer.saveDecision({
      applicationId: chosenId,
      decidedAt: decidedAt || todayISO(api.now),
      reasonTags: tags,
      note,
      declinedIds: declined.filter((id) => id !== chosenId),
    });
    setConfirmOverwrite(false);
    setOpen(false);
    api.toast('已记录你的选择，可以随时回看');
  };

  return (
    <div className="dec" data-testid="decision-form">
      <div className={CLS.t}>
        <h3 className={CLS.l}>{existing ? '我的选择' : '还没做选择'}</h3>
        <span className={CLS.u}>
          {existing
            ? `${labelOf(existing.applicationId)} · ${existing.decidedAt}`
            : '定了之后回来记一笔 —— 半年后你会想知道当时为什么这么选'}
        </span>
        <button type="button" className={CLS.b} onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? '收起' : existing ? '改选 / 补充理由' : '记一笔'}
        </button>
      </div>

      {view && !open ? (
        <div className="dec__view">
          {view.decision.reasonTags.length > 0 ? (
            <p className="dec__tags">
              {view.decision.reasonTags.map((tag) => (
                <span key={tag} className={CLS.aj}>
                  {tag}
                </span>
              ))}
            </p>
          ) : null}
          {view.firstLines ? <p className="dec__note">{view.firstLines}</p> : null}
          {view.declined.length > 0 ? (
            <p className={CLS.d}>我放弃了：{view.declined.map((item) => item.label).join('；')}</p>
          ) : null}
        </div>
      ) : null}

      {open ? (
        <div className="dec__form" data-testid="decision-fields">
          <label className={CLS.g}>
            <span className={CLS.a}>我选了</span>
            <select className={CLS.D} value={chosenId} onChange={(event) => setChosenId(event.target.value)}>
              <option value="">选一个 Offer</option>
              {candidates.map((item) => (
                <option key={item.app.id} value={item.app.id}>
                  {labelOf(item.app.id)}
                </option>
              ))}
            </select>
          </label>

          <label className={CLS.e}>
            <span className={CLS.a}>决策日</span>
            <input
              className={CLS.f}
              type="date"
              value={decidedAt}
              onChange={(event) => setDecidedAt(event.target.value)}
            />
          </label>

          <div className="dec__tags-pick">
            <span className={CLS.a}>为什么（最多 {DECISION_TAG_LIMIT} 个）</span>
            <div className="dec__tag-btns">
              {REASON_TAG_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  className={cx(CLS.v, tags.includes(preset.label) && 'is-active')}
                  onClick={() => toggleTag(preset.label)}
                  aria-pressed={tags.includes(preset.label)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <label className={CLS.g}>
            <span className={CLS.a}>一段话（回看时只看前三行）</span>
            <textarea
              className={CLS.T}
              value={note}
              maxLength={DECISION_NOTE_LIMIT}
              rows={3}
              placeholder="当时怎么想的？放弃了什么？"
              onChange={(event) => setNote(event.target.value)}
            />
          </label>

          {candidates.filter((item) => item.app.id !== chosenId).length > 0 ? (
            <div className="dec__declined">
              <span className={CLS.a}>当时放弃了谁（点一下标记）</span>
              <div className="dec__tag-btns">
                {candidates
                  .filter((item) => item.app.id !== chosenId)
                  .map((item) => (
                    <button
                      key={item.app.id}
                      type="button"
                      className={cx(CLS.v, declined.includes(item.app.id) && 'is-active')}
                      onClick={() => toggleDeclined(item.app.id)}
                      aria-pressed={declined.includes(item.app.id)}
                    >
                      {labelOf(item.app.id)}
                    </button>
                  ))}
              </div>
            </div>
          ) : null}

          <div className={CLS.p}>
            <button type="button" className={CLS.b} onClick={() => setOpen(false)}>
              取消
            </button>
            <button type="button" className={CLS.af} onClick={save} disabled={!canSave}>
              {existing && !confirmOverwrite ? '改选需再确认一次' : '记下这个选择'}
            </button>
          </div>
          {existing && confirmOverwrite ? (
            <p className={CLS.s} role="alert">
              这会覆盖掉你在 {existing.decidedAt} 记的那一条。再点一次按钮就覆盖。
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 回看卡的「前 3 行」由 `decisionViewOf` 算好（firstLines），组件不再算一遍 —— 两处算就会两处漂移 */
