/**
 * 模块三 · 快记确认条（CAP-5 / CAP-8 / CAP-12 / CAP-13）。
 *
 * 这一块是「猜不准就问」的落点：每个 chip 都能改，改不了的地方老实说改不了。
 * 三条不许违反的规矩：
 * 1. 公司三态（唯一 / 多候选 / 无候选）都要**显式**呈现，不许默认取第一条；
 * 2. 状态建议默认**未勾选**（勾了才写）；
 * 3. 面试形式解析不出就留空并要求手选 —— 绝不默认「视频」。
 */

import type { Application, InterviewFormat, InterviewKind, Status } from '../../types';
import type { CaptureDraft, CaptureIntent } from '../../lib/capture/parse';
import { INTENT_LABEL, captureTimeLabel, shiftToNextYear } from '../../lib/capture/parse';
import { STATUS_LABEL } from '../../lib/rules';
import { cx } from '../../lib/util';
import { CLS } from '../../lib/classTokens';

/** 确认条上可改的字段（草案 + 用户在 chip 上的修正） */
export interface CaptureState {
  intent: CaptureIntent;
  /**
   * 当前选定的公司 id。
   *
   * 唯一命中时 = `draft.company.item.id`；多候选时这里是用户**点选**的那一家
   * （CAP-5 的「不替用户选」落点是「必须点一下」，不是「点了没反应」）。
   * null = 还没定 —— 此时确认条无法推出岗位候选。
   */
  companyId: string | null;
  /** 关联到已有投递；null = 需要新建 */
  applicationId: string | null;
  newCompanyName: string | null;
  newJobTitle: string | null;
  scheduledAt: string | null;
  round: number | null;
  kind: InterviewKind | null;
  format: InterviewFormat | null;
  statusSuggestion: Status | null;
  statusConfirmed: boolean;
  /**
   * CAP-4：过去日期是否已经由用户表过态（选「是，明年」或「否」都算）。
   *
   * 为什么不直接看 `scheduledAt`：只说「1月5日」时 `scheduledAt` 本来就是 null
   * （CAP-3 规定只有日期不进日历），那时仍然要问「是明年吗」。
   */
  pastDateAck: boolean;
}

export const INTENT_OPTIONS: ReadonlyArray<CaptureIntent> = ['interview', 'chat', 'followup', 'memo'];

export const FORMAT_OPTIONS: ReadonlyArray<{ value: InterviewFormat; label: string }> = [
  { value: 'video', label: '视频' },
  { value: 'phone', label: '电话' },
  { value: 'onsite', label: '现场' },
];

const ROUND_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '笔试' },
  { value: 1, label: '一面' },
  { value: 2, label: '二面' },
  { value: 3, label: '三面' },
  { value: 4, label: '四面' },
  { value: 5, label: '五面' },
];

export interface CaptureChipsProps {
  draft: CaptureDraft;
  state: CaptureState;
  /** 「新建公司」按钮上展示的候选名（由原文剥出来的，只作建议） */
  newCompanyGuess: string;
  /** 已选公司下的未删除投递（岗位 chip 的候选） */
  appsOfCompany: Application[];
  /**
   * 形式是不是真的必填。
   *
   * 不写成组件内推导：走「新建投递」这条路时压根建不出面试，此时若把形式标成必填、
   * 又让保存按钮可用，界面上就会出现两句互相打脸的话。
   */
  formatRequired: boolean;
  /**
   * CAP-4：当前时间落在过去，等用户二选。
   *
   * 不在这里自己算：组件拿不到 `now`，而「过去」是相对当前时刻的判断。
   * 由 QuickCapture 用 `isPastDateBlocked(confirmed, now)` 算好传进来。
   */
  pastDate: boolean;
  onChange: (patch: Partial<CaptureState>) => void;
}

export function CaptureChips({
  draft,
  state,
  newCompanyGuess,
  appsOfCompany,
  formatRequired,
  pastDate,
  onChange,
}: CaptureChipsProps) {
  const companyPick = draft.company;
  const companyCandidates = companyPick.state === 'ambiguous' ? companyPick.items : [];
  /** 唯一命中直接算选定；多候选要等用户点一下 */
  const pickedCompany =
    companyPick.state === 'unique'
      ? companyPick.item
      : companyCandidates.find((item) => item.id === state.companyId) ?? null;
  const chosenApp = state.applicationId
    ? appsOfCompany.find((item) => item.id === state.applicationId) ?? null
    : null;

  return (
    <div className="cap" data-testid="capture-chips">
      {/* 意图：用户说的和系统听懂的可能不一样，第一件事就是让他改 */}
      <div className={CLS.aN}>
        <span className={CLS.aM}>记什么</span>
        <div className="seg" role="group" aria-label="记录类型">
          {INTENT_OPTIONS.map((intent) => (
            <button
              key={intent}
              type="button"
              className={cx('seg__item', state.intent === intent && 'is-active')}
              onClick={() => onChange({ intent })}
            >
              {INTENT_LABEL[intent]}
            </button>
          ))}
        </div>
      </div>

      {/* 公司：三态都摆出来 */}
      <div className={CLS.aN}>
        <span className={CLS.aM}>哪家公司</span>
        {state.newCompanyName ? (
          <span className={CLS.aU}>
            新建「{state.newCompanyName}」
            <button
              type="button"
              className={CLS.k}
              onClick={() => onChange({ newCompanyName: null, newJobTitle: null, applicationId: null })}
            >
              取消
            </button>
          </span>
        ) : pickedCompany ? (
          <span className={CLS.aU}>
            {pickedCompany.shortName || pickedCompany.name}
            {companyPick.state === 'ambiguous' ? (
              <button
                type="button"
                className={CLS.k}
                data-testid="cap-company-reset"
                onClick={() => onChange({ companyId: null, applicationId: null })}
              >
                换一家
              </button>
            ) : null}
          </span>
        ) : companyPick.state === 'ambiguous' ? (
          <span className="cap__choices">
            <span className={cx(CLS.d, 'cap__ask')}>有两家可能，选一个：</span>
            {companyCandidates.map((item) => (
              <button
                key={item.id}
                type="button"
                className={CLS.v}
                data-testid={`cap-company-${item.id}`}
                onClick={() => onChange({ companyId: item.id, applicationId: null, newCompanyName: null })}
              >
                {item.shortName || item.name}
              </button>
            ))}
          </span>
        ) : (
          <span className="cap__choices">
            <span className={cx(CLS.d, 'cap__ask')}>哪家公司？</span>
            {newCompanyGuess ? (
              <button
                type="button"
                className={CLS.v}
                data-testid="cap-new-company"
                onClick={() =>
                  onChange({
                    companyId: null,
                    newCompanyName: newCompanyGuess,
                    newJobTitle: null,
                    applicationId: null,
                  })
                }
              >
                新建公司「{newCompanyGuess}」
              </button>
            ) : null}
          </span>
        )}
      </div>

      {/* 岗位：≥2 条时一律留空，用户自己选 */}
      <div className={CLS.aN}>
        <span className={CLS.aM}>哪个岗位</span>
        {state.newCompanyName ? (
          <input
            className={CLS.G}
            value={state.newJobTitle ?? ''}
            placeholder="岗位名，例如 前端开发实习生"
            aria-label="新岗位名"
            onChange={(event) => onChange({ newJobTitle: event.target.value })}
          />
        ) : chosenApp ? (
          <span className={CLS.aU}>{chosenApp.jobTitle}</span>
        ) : appsOfCompany.length > 0 ? (
          <select
            className={CLS.q}
            value=""
            aria-label="选岗位"
            onChange={(event) => onChange({ applicationId: event.target.value || null })}
          >
            <option value="">选一个岗位</option>
            {appsOfCompany.map((item) => (
              <option key={item.id} value={item.id}>
                {item.jobTitle}
              </option>
            ))}
          </select>
        ) : (
          <span className={CLS.d}>这家还没有投递记录</span>
        )}
      </div>

      {/* 时间：只有日期或只有时刻都要说清楚「进不了日历」 */}
      {state.intent === 'interview' ? (
        <>
          <div className={CLS.aN}>
            <span className={CLS.aM}>什么时候</span>
            <span className={cx('cap__chip', !state.scheduledAt && 'is-warn')}>
              {captureTimeLabel(state.scheduledAt)}
            </span>
            {draft.timePartial === 'dateOnly' ? (
              <span className={CLS.c}>只有日期 —— 补个时刻就能进日历</span>
            ) : null}
            {draft.timePartial === 'timeOnly' ? (
              <span className={CLS.c}>只有时刻 —— 补个日期就能进日历</span>
            ) : null}
            {draft.timeVague ? <span className={CLS.s}>时间不确定，请手选日期</span> : null}
            {pastDate ? (
              <span className="cap__past" role="alert">
                <span className={CLS.s}>这天已经过了，是明年吗？</span>
                <button
                  type="button"
                  className={CLS.h}
                  data-testid="capture-past-yes"
                  onClick={() =>
                    onChange({
                      scheduledAt: state.scheduledAt ? shiftToNextYear(state.scheduledAt) : null,
                      pastDateAck: true,
                    })
                  }
                >
                  是，明年
                </button>
                {/* 选「否」= 时间作废，回「未定」等用户手选；绝不替用户换个日期 */}
                <button
                  type="button"
                  className={CLS.h}
                  data-testid="capture-past-no"
                  onClick={() => onChange({ scheduledAt: null, pastDateAck: true })}
                >
                  否
                </button>
              </span>
            ) : null}
          </div>

          <div className={CLS.aN}>
            <span className={CLS.aM}>第几轮</span>
            <select
              className={CLS.q}
              value={state.round === null ? '' : String(state.round)}
              aria-label="第几轮"
              onChange={(event) =>
                onChange({ round: event.target.value === '' ? null : Number(event.target.value) })
              }
            >
              <option value="">没定</option>
              {ROUND_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className={CLS.aN}>
            <span className={CLS.aM}>什么形式</span>
            <select
              className={cx(CLS.q, formatRequired && !state.format && 'cap__select--required')}
              value={state.format ?? ''}
              aria-label="面试形式"
              onChange={(event) => onChange({ format: (event.target.value || null) as InterviewFormat | null })}
            >
              <option value="">请选择（必填）</option>
              {FORMAT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {formatRequired && !state.format ? (
              <span className={CLS.s}>形式是必填项 —— 猜不出来就请你选一个</span>
            ) : null}
          </div>
        </>
      ) : null}

      {/* 状态建议：识别到了也默认不勾 */}
      {draft.statusSuggestion ? (
        <div className={CLS.aN}>
          <span className={CLS.aM}>顺带改状态？</span>
          <label className="cap__check">
            <input
              type="checkbox"
              checked={state.statusConfirmed}
              onChange={(event) => onChange({ statusConfirmed: event.target.checked })}
              data-testid="cap-status-confirm"
            />
            <span>状态 → {STATUS_LABEL[draft.statusSuggestion]}</span>
          </label>
          <span className={CLS.c}>默认不改。确认了才写入，免得一句话就把管线改错。</span>
        </div>
      ) : null}

    </div>
  );
}
