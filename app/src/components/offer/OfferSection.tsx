/**
 * 模块一 · Offer 录入区块（详情抽屉里的一段）。
 *
 * 三条产品口径：
 * 1. **全空折叠成一行**（OFF-1）：还没拿到 Offer 的人不该被 9 个空输入框挡住视线；
 * 2. **只填月薪也能存**（OFF-2）：拿到口头 offer 时用户往往只知道一个数字；
 * 3. 编辑本区块**不写 note、不动 lastActivityAt** —— 改了薪资不该让沉默天数归零。
 */

import { useState } from 'react';
import type { AppApi } from '../../lib/api';
import type { Application, OfferScoreKey } from '../../types';
import { OFFER_SCORE_KEYS, annualTotalText, computeOfferScore, missingScoreCount } from '../../lib/offer/score';
import { cx } from '../../lib/util';
import { CLS } from '../../lib/classTokens';
import { Field } from '../Field';

const SCORE_LABEL: Record<OfferScoreKey, string> = {
  salary: '薪资',
  growth: '成长',
  city: '城市',
  wlb: 'WLB',
};

/** 1~5 的自评分值（0 = 未评，点一下当前值即取消） */
const SCORE_VALUES: ReadonlyArray<1 | 2 | 3 | 4 | 5> = [1, 2, 3, 4, 5];

export interface OfferSectionProps {
  api: AppApi;
  app: Application;
}

export function OfferSection({ api, app }: OfferSectionProps) {
  const offer = app.offer;
  const [open, setOpen] = useState(false);
  const weights = api.offer.weights;
  const score = computeOfferScore(offer?.scores, weights);
  const annual = annualTotalText(offer);
  const missing = missingScoreCount(offer);

  const patch = (next: Parameters<AppApi['offer']['saveOffer']>[1]): void => {
    api.offer.saveOffer(app.id, next);
  };

  const scores = offer?.scores ?? {};
  const toggleScore = (key: OfferScoreKey, value: 1 | 2 | 3 | 4 | 5): void => {
    const next = { ...scores };
    if (next[key] === value) delete next[key];
    else next[key] = value;
    patch({ scores: next });
  };

  // 折叠态的一行摘要：有分就给分，没分就老实说「还没评」
  const summaryParts: string[] = [];
  summaryParts.push(score.total === null ? '还没评分' : `综合分 ${score.total.toFixed(1)}`);
  if (offer && score.total !== null && score.normalized) summaryParts.push(`按 ${score.ratedCount}/4 维归一`);
  summaryParts.push(annual);
  if (missing > 0 && score.ratedCount > 0) summaryParts.push(`还有 ${missing} 维没评`);

  return (
    <section className={CLS.n} data-testid="offer-section">
      <div className={CLS.w}>
        <h3 className={CLS.i}>Offer 对比信息</h3>
        <button
          type="button"
          className={CLS.b}
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          data-testid="offer-toggle"
        >
          {open ? '收起' : offer ? '编辑' : '记一笔'}
        </button>
      </div>

      {/*
        折叠时也要能看到结论：光给一个「记一笔」按钮，用户还得点开才知道自己打过几分。
        这一行永远在，展开与否只影响下面的表单。
      */}
      <button
        type="button"
        className={cx('offer-fold', !offer && 'is-empty')}
        onClick={() => setOpen(true)}
        data-testid="offer-fold"
      >
        <span className="offer-fold__text">{summaryParts.join(' · ')}</span>
        <span className="offer-fold__hint">{open ? '' : '展开 ▸'}</span>
      </button>

      {open ? (
        <div className="offer-form" data-testid="offer-form">
          <div className="offer-form__row">
            <label className={CLS.e}>
              <span className={CLS.a}>计薪方式</span>
              <div className="seg" role="group" aria-label="计薪方式">
                {(['monthly', 'daily'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={cx('seg__item', (offer?.payMode ?? 'monthly') === mode && 'is-active')}
                    onClick={() => patch({ payMode: mode })}
                  >
                    {mode === 'monthly' ? '按月' : '按天'}
                  </button>
                ))}
              </div>
            </label>
            {(offer?.payMode ?? 'monthly') === 'monthly' ? (
              <>
                <Field
                  label="月薪（元，税前）"
                  type="number"
                  min={0}
                  value={offer?.monthlySalary ? String(offer.monthlySalary) : ''}
                  onCommit={(value) => patch({ monthlySalary: toPositiveInt(value) })}
                  placeholder="20000"
                  narrow
                />
                <Field
                  label="薪数（含年终）"
                  type="number"
                  min={12}
                  max={24}
                  value={offer?.salaryMonths ? String(offer.salaryMonths) : ''}
                  onCommit={(value) => patch({ salaryMonths: toPositiveInt(value) })}
                  hint="一年发几个月，年终奖已含在里面"
                  narrow
                />
              </>
            ) : (
              <Field
                label="日薪（元/天）"
                type="number"
                min={0}
                value={offer?.dailyRate ? String(offer.dailyRate) : ''}
                onCommit={(value) => patch({ dailyRate: toPositiveInt(value) })}
                placeholder="400"
                narrow
              />
            )}
            <Field
              label="签字费（元）"
              type="number"
              min={0}
              value={offer?.signOnBonus !== undefined ? String(offer.signOnBonus) : ''}
              onCommit={(value) => patch({ signOnBonus: toNonNegativeInt(value) })}
              hint="0 和「没填」是两件事"
              narrow
            />
            <Field
              label="单程通勤（分钟）"
              type="number"
              min={0}
              max={240}
              value={offer?.commuteMin !== undefined ? String(offer.commuteMin) : ''}
              onCommit={(value) => patch({ commuteMin: toNonNegativeInt(value) })}
              narrow
            />
            <Field
              label="职级"
              value={offer?.level ?? ''}
              onCommit={(value) => patch({ level: value.trim() || null })}
              placeholder="P5 / T1.2 / SP"
              narrow
            />
            <Field
              label="股权 / 期权"
              value={offer?.equityText ?? ''}
              onCommit={(value) => patch({ equityText: value.trim() || null })}
              placeholder="5000 股 / 4 年"
              hint="只记原文，不折算成钱"
              narrow
            />
          </div>

          <div className="offer-form__scores">
            <span className={CLS.a}>四维自评（缺 = 未评，不按 0 分算）</span>
            <div className="offer-scores">
              {OFFER_SCORE_KEYS.map((key) => (
                <div key={key} className="offer-scores__row">
                  <span className="offer-scores__label">
                    {SCORE_LABEL[key]}
                    <span className={CLS.d}>{` 权重 ${weights[key]}`}</span>
                  </span>
                  <div className="offer-scores__btns" role="group" aria-label={`${SCORE_LABEL[key]}评分`}>
                    {SCORE_VALUES.map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={cx('score-btn', scores[key] === value && 'is-on')}
                        onClick={() => toggleScore(key, value)}
                        aria-pressed={scores[key] === value}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <Field
            label="补充说明"
            value={offer?.notes ?? ''}
            onCommit={(value) => patch({ notes: value.trim() || null })}
            placeholder="口头承诺的转正比例、加班情况…"
          />
        </div>
      ) : null}
    </section>
  );
}

/** 空串 = 清空该字段（null），否则取整；负数交给 validate 层兜底 */
function toPositiveInt(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** 0 是合法值（签字费 0、通勤 0 分钟），所以只把空串当清空 */
function toNonNegativeInt(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? Math.round(n) : null;
}
