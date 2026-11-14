/**
 * 模块一 · 四维权重面板（OFF-5）。
 *
 * 「一次调完一直生效」是这一块的价值观：权重是**我的价值观**，不是这次比较的临时参数。
 * 所以拖动任一滑块后，其余三项按原比例分摊剩余值，四项和恒为 100。
 */

import { useEffect, useState } from 'react';
import type { OfferScoreKey } from '../../types';
import { DEFAULT_OFFER_WEIGHTS, OFFER_SCORE_KEYS, OFFER_WEIGHT_TOTAL, rebalanceWeights } from '../../lib/offer/score';
import { cx } from '../../lib/util';
import { CLS } from '../../lib/classTokens';
import { WEIGHT_DIM_LABEL } from './CompareTable';

export interface WeightPanelProps {
  weights: Record<OfferScoreKey, number>;
  /** 拖动结束才写库（写 settings.offerWeights，不入撤销栈） */
  onCommit: (weights: Record<OfferScoreKey, number>) => void;
}

export function WeightPanel({ weights, onCommit }: WeightPanelProps) {
  const [local, setLocal] = useState<Record<OfferScoreKey, number>>(weights);
  const [open, setOpen] = useState(false);

  // 外部（换库 / 撤销）改了权重时同步回来，否则滑块会显示过期值
  useEffect(() => {
    setLocal(weights);
  }, [weights]);

  const commit = (): void => {
    if (OFFER_SCORE_KEYS.some((key) => local[key] !== weights[key])) onCommit(local);
  };

  const drag = (key: OfferScoreKey, value: number): void => {
    setLocal(rebalanceWeights(local, key, value));
  };

  const total = OFFER_SCORE_KEYS.reduce((acc, key) => acc + local[key], 0);

  return (
    <div className="wcmp" data-testid="weight-panel">
      <div className={CLS.t}>
        <h3 className={CLS.l}>我的权重</h3>
        <span className={CLS.u}>
          {OFFER_SCORE_KEYS.map((key) => `${WEIGHT_DIM_LABEL[key]} ${local[key]}`).join(' / ')}（合计 {total}）
        </span>
        <button type="button" className={CLS.b} onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? '收起' : '调整'}
        </button>
      </div>

      {open ? (
        <div className="wcmp__sliders">
          {OFFER_SCORE_KEYS.map((key) => (
            <label key={key} className="wcmp__slider">
              <span className="wcmp__slider-label">
                {WEIGHT_DIM_LABEL[key]} <strong>{local[key]}</strong>
              </span>
              <input
                type="range"
                min={0}
                max={OFFER_WEIGHT_TOTAL}
                step={1}
                value={local[key]}
                aria-label={`${WEIGHT_DIM_LABEL[key]}权重`}
                onChange={(event) => drag(key, Number(event.target.value))}
                onMouseUp={commit}
                onTouchEnd={commit}
                onKeyUp={commit}
                onBlur={commit}
              />
            </label>
          ))}
          <p className={cx(CLS.c, 'wcmp__hint')}>
            拖动一个，其余三个按原比例分摊。改完就一直生效 —— 这是你的判断标准，不是这一次比较的参数。
          </p>
          <button
            type="button"
            className={CLS.k}
            onClick={() => {
              const reset: Record<OfferScoreKey, number> = { ...DEFAULT_OFFER_WEIGHTS };
              setLocal(reset);
              onCommit(reset);
            }}
          >
            恢复默认 30 / 30 / 20 / 20
          </button>
        </div>
      ) : null}
    </div>
  );
}
