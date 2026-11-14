/**
 * ＋记一家 浮层。
 * 只有「公司名 + 岗位名」两个必填，其余折叠在「补充更多」里。
 * 回车即保存，保存后留在浮层并提示「+1，继续记下一家」—— 因为 BOSS 上常常连着记好几家。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppApi } from '../lib/api';
import type { Channel, Status } from '../types';
import { CHANNEL_LABEL, CHANNEL_OPTIONS, STATUS_LABEL } from '../lib/rules';
import { todayISO } from '../lib/date';
import { cx } from '../lib/util';
import { CLS } from '../lib/classTokens';
import { QuickCapture } from './capture/QuickCapture';

export interface QuickAddProps {
  api: AppApi;
  /** 初始状态：看板某一列点「＋」时带入该列状态，默认「已投递」 */
  initialStatus?: Status;
  /**
   * 打开时焦点落在哪。
   *
   * `Q` 键进来是「我有一句话想说」，焦点必须在快记框上 —— 落在公司名上等于
   * 让人先把那句话打进公司名里。点「＋记一家」进来则相反。
   */
  initialFocus?: 'form' | 'capture';
  onClose: () => void;
}

/** 浮层里可一眼切换的两个高频状态 */
const PRIMARY_STATUSES: Status[] = ['wishlist', 'applied'];

export function QuickAdd({ api, initialStatus, initialFocus = 'form', onClose }: QuickAddProps) {
  const [company, setCompany] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [status, setStatus] = useState<Status>(() => initialStatus || 'applied');
  const [more, setMore] = useState(false);
  const [city, setCity] = useState('');
  const [channel, setChannel] = useState<Channel | ''>('boss');
  const [appliedAt, setAppliedAt] = useState(todayISO());
  const [resumeVersion, setResumeVersion] = useState(api.db.settings.defaultResumeVersion || '');
  const [salaryText, setSalaryText] = useState('');
  const [daysPerWeek, setDaysPerWeek] = useState('');
  const [durationMonths, setDurationMonths] = useState('');
  const [jdUrl, setJdUrl] = useState('');
  const [added, setAdded] = useState(0);
  /** 重复提醒出现后，用户第二次点击才真正写入（不做静默拦截，也不做静默放行） */
  const [dupConfirmed, setDupConfirmed] = useState(false);
  /** 快记里点了「改用手动记录」：把这句原文留在这儿给人照着填，不猜、不写库 */
  const [fallbackRaw, setFallbackRaw] = useState('');

  /**
   * 同公司 + 同岗位是否已经记过。
   * 归一化只做两件确定的事：去空白、忽略大小写 —— 不做模糊匹配，
   * 因为「前端开发」和「前端开发工程师」是两道不同的投递，误报比漏报更烦人。
   */
  const duplicate = useMemo(() => {
    const companyKey = company.trim().toLowerCase();
    const jobKey = jobTitle.trim().toLowerCase();
    if (!companyKey || !jobKey) return null;
    const companyIds = new Set(
      api.db.companies.filter((item) => item.name.trim().toLowerCase() === companyKey).map((item) => item.id),
    );
    if (companyIds.size === 0) return null;
    return (
      api.db.applications.find(
        (app) => companyIds.has(app.companyId) && app.jobTitle.trim().toLowerCase() === jobKey,
      ) ?? null
    );
  }, [api.db.applications, api.db.companies, company, jobTitle]);

  const companyRef = useRef<HTMLInputElement | null>(null);
  const jobRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (initialFocus === 'capture') return;
    companyRef.current?.focus();
  }, [initialFocus]);

  const canSave = company.trim().length > 0 && jobTitle.trim().length > 0;

  const reset = (): void => {
    setCompany('');
    setJobTitle('');
    setCity('');
    setSalaryText('');
    setDaysPerWeek('');
    setDurationMonths('');
    setJdUrl('');
    setDupConfirmed(false);
    setFallbackRaw('');
    setAppliedAt(todayISO());
    companyRef.current?.focus();
  };

  const save = (): void => {
    if (!canSave) {
      if (!company.trim()) companyRef.current?.focus();
      else jobRef.current?.focus();
      return;
    }
    // 第一次点击只提醒，不写入：重复投递可能是真的（换个批次再投一次），也可能是手滑
    if (duplicate && !dupConfirmed) {
      setDupConfirmed(true);
      return;
    }
    api.addApplication({
      companyName: company.trim(),
      jobTitle: jobTitle.trim(),
      status,
      city: city.trim() || undefined,
      channel: channel || undefined,
      appliedAt: status === 'wishlist' ? undefined : appliedAt || undefined,
      resumeVersion: resumeVersion.trim() || undefined,
      salaryText: salaryText.trim() || undefined,
      daysPerWeek: Number(daysPerWeek) > 0 ? Number(daysPerWeek) : undefined,
      durationMonths: Number(durationMonths) > 0 ? Number(durationMonths) : undefined,
      jdUrl: jdUrl.trim() || undefined,
    });
    setAdded((prev) => prev + 1);
    reset();
  };

  return (
    <div
      className={CLS.U}
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="modal modal--quickadd" onClick={(event) => event.stopPropagation()}>
        <header className={CLS.ac}>
          <h2 className={CLS.Y}>＋ 记一家</h2>
          <button type="button" className={CLS.m} onClick={onClose} title="关闭（Esc）" aria-label="关闭">
            ✕
          </button>
        </header>

        <div className={CLS.aa}>
          {/* 模块三落在浮层顶部：一句话能记清就不用填表单；听不懂时它自己会让路（改用手动记录） */}
          <QuickCapture
            api={api}
            autoFocus={initialFocus === 'capture'}
            onFallback={(raw) => {
              setFallbackRaw(raw);
              companyRef.current?.focus();
            }}
          />

          {fallbackRaw ? (
            <p className="qa-fallback">
              刚才那句留在这儿：<strong>{fallbackRaw}</strong>
              —— 照着填就行。快记只是没听懂，一个字都没写进库。
            </p>
          ) : null}

          <div className="qa-row">
            <label className={CLS.g}>
              <span className={CLS.a}>公司名 *</span>
              <input
                ref={companyRef}
                className="input input--lg"
                value={company}
                placeholder="小红书"
                onChange={(event) => {
                  setCompany(event.target.value);
                  setDupConfirmed(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    jobRef.current?.focus();
                  }
                }}
              />
            </label>
            <label className={CLS.g}>
              <span className={CLS.a}>岗位名 *</span>
              <input
                ref={jobRef}
                className="input input--lg"
                value={jobTitle}
                placeholder="前端开发实习生"
                onChange={(event) => {
                  setJobTitle(event.target.value);
                  setDupConfirmed(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    save();
                  }
                }}
              />
            </label>
          </div>

          {duplicate ? (
            <div className={cx('qa-dup', dupConfirmed && 'is-confirmed')} role="alert">
              <span className="qa-dup__icon" aria-hidden="true">
                ⚠
              </span>
              <span>
                已经记过同一家同一个岗位：<strong>{STATUS_LABEL[duplicate.status]}</strong>
                {duplicate.appliedAt ? ` · 投递于 ${duplicate.appliedAt}` : ''}。
                {dupConfirmed ? '再点一次「仍然保存」就会多记一条。' : '确实是又一次投递，就再点一次保存。'}
              </span>
            </div>
          ) : null}

          <div className="qa-row qa-row--status">
            <div className="qa-status">
              <span className="qa-status__label">放到哪一列</span>
              <div className="seg" role="group" aria-label="初始状态">
                {/* 若从看板某列点「＋」进来，把这个状态也显示成一段，避免"选中的状态看不见" */}
                {(PRIMARY_STATUSES.includes(status) ? PRIMARY_STATUSES : [status, ...PRIMARY_STATUSES]).map(
                  (option) => (
                    <button
                      key={option}
                      type="button"
                      className={cx('seg__item', status === option && 'is-active')}
                      onClick={() => setStatus(option)}
                    >
                      {STATUS_LABEL[option]}
                    </button>
                  ),
                )}
              </div>
              <span className="qa-status__hint">
                {status === 'wishlist'
                  ? '还没投也能先记着，超过 7 天会提醒你「还想投吗」'
                  : '大部分是投完才来记，所以默认选它'}
              </span>
            </div>
            <button type="button" className="link-btn qa-more" onClick={() => setMore(!more)}>
              {more ? '收起补充信息' : '补充更多（选填）'}
            </button>
          </div>

          {more ? (
            <div className="qa-more-grid">
              <label className={CLS.e}>
                <span className={CLS.a}>城市</span>
                <input className={CLS.f} value={city} onChange={(event) => setCity(event.target.value)} placeholder="北京" />
              </label>
              <label className={CLS.e}>
                <span className={CLS.a}>渠道</span>
                <select
                  className={CLS.D}
                  value={channel}
                  onChange={(event) => setChannel(event.target.value as Channel | '')}
                >
                  <option value="">未标注</option>
                  {CHANNEL_OPTIONS.map((item) => (
                    <option key={item} value={item}>
                      {CHANNEL_LABEL[item]}
                    </option>
                  ))}
                </select>
              </label>
              <label className={CLS.e}>
                <span className={CLS.a}>投递日期</span>
                <input
                  className={CLS.f}
                  type="date"
                  value={appliedAt}
                  onChange={(event) => setAppliedAt(event.target.value)}
                />
              </label>
              <label className={CLS.e}>
                <span className={CLS.a}>简历版本</span>
                <input
                  className={CLS.f}
                  value={resumeVersion}
                  onChange={(event) => setResumeVersion(event.target.value)}
                  placeholder="v3-前端-项目版"
                />
              </label>
              <label className={CLS.e}>
                <span className={CLS.a}>薪资原文</span>
                <input
                  className={CLS.f}
                  value={salaryText}
                  onChange={(event) => setSalaryText(event.target.value)}
                  placeholder="200-300/天"
                />
              </label>
              <label className={CLS.e}>
                <span className={CLS.a}>每周到岗（天）</span>
                <input
                  className={CLS.f}
                  type="number"
                  min={1}
                  max={7}
                  value={daysPerWeek}
                  onChange={(event) => setDaysPerWeek(event.target.value)}
                  placeholder="3"
                />
              </label>
              <label className={CLS.e}>
                <span className={CLS.a}>可实习（月）</span>
                <input
                  className={CLS.f}
                  type="number"
                  min={1}
                  value={durationMonths}
                  onChange={(event) => setDurationMonths(event.target.value)}
                  placeholder="4"
                />
              </label>
              <label className={CLS.g}>
                <span className={CLS.a}>JD 链接</span>
                <input
                  className={CLS.f}
                  value={jdUrl}
                  onChange={(event) => setJdUrl(event.target.value)}
                  placeholder="https://"
                />
              </label>
            </div>
          ) : null}

          {added > 0 ? <p className="qa-toast">+{added}，继续记下一家</p> : null}
        </div>

        <footer className={CLS.ab}>
          <span className={cx('qa-hint', !canSave && 'is-warn')}>
            {canSave ? 'Enter 保存，Esc 退出' : '填公司名和岗位名就能保存'}
          </span>
          <div className="modal__actions">
            <button type="button" className="btn" onClick={onClose}>
              关掉
            </button>
            <button type="button" className={CLS.j} onClick={save} disabled={!canSave}>
              {duplicate && !dupConfirmed ? '仍然保存' : '保存并继续'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
