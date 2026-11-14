/**
 * 模块三 · 一句话快记（CAP-1 ~ CAP-14）。
 *
 * 落位：嵌在「＋记一家」浮层的顶部（不改导航 —— PRD-v0.2 §E.1 的约定）。
 *
 * 这个组件的全部职责是「把一句话变回一次确认」：
 * 输入 → 纯本地规则解析（**不发任何网络请求**）→ 确认条 → 用户点保存才写库。
 * 三种情形必须给出**不同**的出口：
 * - 没听懂（CAP-9）：说没听懂 + 「改用手动记录」，原文不动；
 * - 不知道哪家公司（CAP-5）：问「哪家公司？」+「新建公司『X』」；
 * - 缺必填（CAP-12）：保存置灰 + 就地说明缺什么。
 */

import { useEffect, useMemo, useState } from 'react';
import type { AppApi } from '../../lib/api';
import type { CaptureContext, CaptureDraft, ConfirmedCapture } from '../../lib/capture/parse';
import {
  captureSummary,
  guessNewCompanyName,
  parseQuickNote,
  planCaptureCommit,
} from '../../lib/capture/parse';
import { CAPTURE_DICT_VERSION } from '../../lib/capture/dict';
import { cx } from '../../lib/util';
import { CLS } from '../../lib/classTokens';
import { CaptureChips, type CaptureState } from './CaptureChips';

export interface QuickCaptureProps {
  api: AppApi;
  /** 「改用手动记录」：把原文交回给下面的「记一家」表单 */
  onFallback: (raw: string) => void;
  /** 挂载即聚焦（`Q` 键进来时用） */
  autoFocus?: boolean;
}

/** 草案 → 确认条的初始状态（用户随后可改） */
function stateOf(draft: CaptureDraft): CaptureState {
  return {
    intent: draft.intent,
    companyId: draft.company.state === 'unique' ? draft.company.item.id : null,
    applicationId: draft.application.state === 'unique' ? draft.application.item.id : null,
    newCompanyName: null,
    newJobTitle: null,
    scheduledAt: draft.scheduledAt,
    round: draft.round,
    kind: draft.kind,
    format: draft.format,
    statusSuggestion: draft.statusSuggestion,
    statusConfirmed: false,
    // 解析出「这天已经过了」时先当作未表态，交给用户在确认条上二选
    pastDateAck: !draft.pastDate,
  };
}

/** 空态与失败态都要交代「识别靠本地词表」（CAP-14 的调试信息，也是隐私承诺） */
const DICT_NOTE = `词典版本 v${CAPTURE_DICT_VERSION}：识别靠本地词表，不联网、不上传。`;

/**
 * 停手 400 ms 再解析（R-06）。
 *
 * 不是性能问题（一句话 < 5 ms），是**阅读问题**：逐字解析会让确认条在打字过程中
 * 反复变身（「明」→「明天」→「明天下午」…），用户看不清也没法点。
 * 清空则立即生效 —— 删光了还要等 400 ms 才收起，才是真的奇怪。
 */
const PARSE_DEBOUNCE_MS = 400;

export function QuickCapture({ api, onFallback, autoFocus = false }: QuickCaptureProps) {
  const [text, setText] = useState('');
  /** 停手后的文本（解析只认它） */
  const [settled, setSettled] = useState('');
  /** 用户在 chip 上改过的值；null = 还没改过，用草案的推断值 */
  const [forced, setForced] = useState<CaptureState | null>(null);

  useEffect(() => {
    if (!text.trim()) {
      setSettled('');
      return undefined;
    }
    const timer = window.setTimeout(() => setSettled(text), PARSE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text]);

  const ctx: CaptureContext = useMemo(
    () => ({
      now: api.now,
      companies: api.db.companies,
      applications: api.db.applications.filter((app) => !app.deletedAt),
      interviews: api.db.interviews,
    }),
    [api.now, api.db.companies, api.db.applications, api.db.interviews],
  );

  const parsed = useMemo(
    () => (settled.trim() ? parseQuickNote(settled, ctx) : null),
    [settled, ctx],
  );

  const draft = parsed && parsed.ok ? parsed : null;
  const state = draft ? forced ?? stateOf(draft) : null;

  /**
   * 已选公司下的投递（岗位 chip 的候选）。
   * 公司没定（含多候选还没点选）就没有候选 —— 不猜岗位（D-12）。
   */
  const activeCompanyId = state?.companyId ?? null;
  const appsOfCompany = useMemo(() => {
    if (!activeCompanyId) return [];
    return ctx.applications.filter((app) => app.companyId === activeCompanyId);
  }, [activeCompanyId, ctx.applications]);

  const input = (
    <label className={CLS.g}>
      <span className={CLS.a}>一句话快记</span>
      <input
        className={CLS.f}
        value={text}
        autoFocus={autoFocus}
        aria-label="一句话快记"
        placeholder="明天下午 3 点字节二面"
        onChange={(event) => {
          setText(event.target.value);
          setForced(null);
        }}
      />
    </label>
  );

  if (!parsed) {
    return (
      <div className="cap-wrap">
        {input}
        <p className={CLS.c}>
          说一句话就能记成一件事：面试、回消息、催进度、随手记。全在本地解析，不上传任何内容。
        </p>
        <p className={CLS.c}>{DICT_NOTE}</p>
      </div>
    );
  }

  if (!parsed.ok) {
    return (
      <div className="cap-wrap" data-testid="capture-failed">
        {input}
        <div className="cap-fail" role="alert">
          <span>{parsed.hint}</span>
          <button type="button" className={CLS.b} onClick={() => onFallback(text)}>
            改用手动记录
          </button>
        </div>
        <p className={CLS.c}>{DICT_NOTE}</p>
      </div>
    );
  }

  if (!draft || !state) return null;

  const confirmed: ConfirmedCapture = {
    raw: draft.raw,
    intent: state.intent,
    applicationId: state.applicationId,
    newCompanyName: state.newCompanyName,
    newJobTitle: state.newJobTitle,
    scheduledAt: state.scheduledAt,
    round: state.round,
    kind: state.kind,
    format: state.format,
    noteType: draft.noteType,
    statusSuggestion: state.statusSuggestion,
    statusConfirmed: state.statusConfirmed,
  };

  const steps = planCaptureCommit(confirmed, ctx);
  /**
   * CAP-4：解析出「这天已经过了」且用户还没表态 → 必须先二选。
   * 判据用确认条自己的 `pastDateAck`，而不是比较 `scheduledAt`：
   * 只说「1月5日」时 `scheduledAt` 是 null（CAP-3），但照样得问「是明年吗」。
   */
  const pastPending = !state.pastDateAck;
  const targetReady =
    Boolean(state.applicationId) || Boolean(state.newCompanyName && (state.newJobTitle ?? '').trim());
  /**
   * 「新建投递」这条路只能写公司名 + 岗位名：落库前拿不到 applicationId，
   * 面试和记录没法挂到正确的那一行。所以此时不该拿「面试形式」卡住保存 ——
   * 卡了也建不出面试，只是白白挡住用户。
   */
  const creatingApplication = !state.applicationId;
  const interviewTimeLost =
    creatingApplication && state.intent === 'interview' && Boolean(state.scheduledAt);
  /**
   * CAP-12：Interview.format 是必填枚举。只要「意图是面试 + 有准确时刻」，
   * 形式就必须由用户选出来 —— 解析不出时不许默认 video，也不许悄悄退化成一条 note。
   */
  const needsFormat =
    !creatingApplication && state.intent === 'interview' && Boolean(state.scheduledAt);
  const canSave =
    targetReady && steps.length > 0 && !pastPending && (!needsFormat || Boolean(state.format));

  const save = (): void => {
    if (!canSave) return;
    api.capture.commit(confirmed);
    // ★ 撤销粒度是「一次写库一个点」，所以说的是「可逐步撤销」而不是「已撤销」
    api.toast(`已记录 ${steps.length} 项，可逐步撤销`);
    setText('');
    setForced(null);
  };

  const newCompanyGuess = draft.company.state === 'none' ? guessNewCompanyName(draft.raw) : '';

  return (
    <div className="cap-wrap">
      {input}

      {draft.droppedTail ? (
        <p className="cap__tail" role="status">
          一次记一件 —— 先记了前半句「{draft.raw}」，后半句「{draft.droppedTail}」等这条记完再补。
        </p>
      ) : null}

      <CaptureChips
        draft={draft}
        state={state}
        newCompanyGuess={newCompanyGuess}
        appsOfCompany={appsOfCompany}
        formatRequired={needsFormat}
        pastDate={pastPending}
        onChange={(patch) => setForced({ ...state, ...patch })}
      />

      <div className={cx(CLS.r, 'cap__foot')}>
        <span className={CLS.c}>
          {captureSummary(confirmed)}
          {steps.length > 1 ? ` —— 共 ${steps.length} 个撤销点，可逐步撤销` : ''}
        </span>
        <div className="modal__actions">
          <button type="button" className={CLS.b} onClick={() => onFallback(text)}>
            改用手动记录
          </button>
          <button
            type="button"
            className={CLS.af}
            onClick={save}
            disabled={!canSave}
            data-testid="capture-save"
          >
            记下来
          </button>
        </div>
      </div>

      {!targetReady ? <p className={CLS.s}>先选一个岗位，或者新建一家公司</p> : null}
      {pastPending ? (
        <p className={CLS.s}>时间落在过去 —— 选「是，明年」或「否」重选一个时间</p>
      ) : null}
      {needsFormat && !state.format ? <p className={CLS.s}>面试形式填了才能保存</p> : null}
      {interviewTimeLost ? (
        <p className={CLS.s}>这次只能先建投递 —— 面试时间建好后再记一次，别丢</p>
      ) : null}

      <p className={CLS.c}>{DICT_NOTE}</p>
    </div>
  );
}
