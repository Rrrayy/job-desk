/**
 * 诊断报告历史（v0.9.1 / R-AI-10，架构 B-09）。
 *
 * ## 为什么是「切换」不是「并排」
 *
 * 报告卡最窄可用宽约 320 px（含维度证据对照），三份并排需要 ≈1000 px，
 * 而纸栏只有 380–460 px。并排要么横向滚动（自己造第二个滚动容器），
 * 要么缩到不可读。切换 = 两个 `‹ ›` 按钮 + 一行「2/3」，代价是零宽度。
 *
 * ## 为什么只有 1 份时连表头都不渲染
 *
 * 与 v0.9 的样子完全一致：用户手上只有一份报告时，「1/1」和两个永远点不动的
 * 按钮只是噪音。历史这件事只在真的有历史的时候才有意义。
 *
 * ## 「当前看第几份」不落盘
 *
 * 同 A-13：`UIViewState` 加字段就要扩校验 + 扩迁移，收益只是「刷新后回到刚才那份」。
 * 刷新后回到第 1 份（最新）反而是更该默认的位置。
 *
 * ## 删除不入撤销栈（Q4）
 *
 * 报告是 AI 的只读产出、可再生缓存，不是用户写的资产（A-07 / §7-6）。
 * 但删除前必须二次确认 + 明确「不可撤销」—— 铁律 6 禁的是静默，不是删除。
 */

import { useState } from 'react';
import type { AppApi } from '../../lib/api';
import { REPORTS_PER_TARGET, reportQuotaOf, reportsOfTarget } from '../../ai/reports';
import { fmtDateTime } from '../../lib/date';
import { cx } from '../../lib/util';
import { CLS } from '../../lib/classTokens';
import { ReportCard } from './ReportCard';

export interface ReportHistoryProps {
  api: AppApi;
  /** 简历 id（服务端按 `resume_diagnosis` + targetId 取报告） */
  resumeId: string;
}

export function ReportHistory({ api, resumeId }: ReportHistoryProps) {
  const rows = api.db.aiReports ?? [];
  const reports = reportsOfTarget(rows, 'resume_diagnosis', resumeId);
  const [cursor, setCursor] = useState(0);
  const [confirming, setConfirming] = useState(false);

  if (reports.length === 0) return null;

  // 删掉一份之后 cursor 可能越界：夹回来，不信任 state 里的旧值
  const index = Math.min(Math.max(cursor, 0), reports.length - 1);
  const shown = reports[index];
  const quota = reportQuotaOf(rows);
  const full = reports.length >= REPORTS_PER_TARGET;

  /** 换一份就把二次确认收起来 —— 否则「确认删除」会跟着换到另一份报告下面 */
  const move = (delta: number): void => {
    setConfirming(false);
    setCursor(index + delta);
  };

  return (
    <div className="report-history">
      {quota.nearlyFull ? (
        <p className={cx(CLS.c, quota.full && 'report-history__quota--full')}>
          全库报告 {quota.used}/{quota.limit}
          {quota.full ? '（已满 —— 先删几份旧的才能继续生成）' : ''}
        </p>
      ) : null}

      {reports.length > 1 ? (
        <div className="report-history__bar">
          <strong className="report-history__title">诊断报告</strong>
          <button
            type="button"
            className={CLS.h}
            aria-label="上一份报告"
            disabled={index === 0}
            onClick={() => move(-1)}
          >
            ‹
          </button>
          <span className="report-history__count" aria-live="polite">
            {index + 1}/{reports.length}
          </span>
          <button
            type="button"
            className={CLS.h}
            aria-label="下一份报告"
            disabled={index === reports.length - 1}
            onClick={() => move(1)}
          >
            ›
          </button>
          <span className={CLS.c}>{fmtDateTime(shown.createdAt)}</span>
          {full ? <span className="report-history__full">已满</span> : null}
          {confirming ? (
            <>
              <button
                type="button"
                className={CLS.V}
                onClick={() => {
                  api.deleteReport(shown.id);
                  setConfirming(false);
                  setCursor(0);
                }}
              >
                确认永久删除
              </button>
              <button type="button" className={CLS.h} onClick={() => setConfirming(false)}>
                取消
              </button>
            </>
          ) : (
            <button type="button" className={CLS.h} onClick={() => setConfirming(true)}>
              删除这份
            </button>
          )}
        </div>
      ) : null}

      {confirming ? (
        <p className={CLS.s}>
          这一份报告（{fmtDateTime(shown.createdAt)}
          {shown.scoreLocal !== undefined ? ` · ${shown.scoreLocal} 分` : ''}）会永久删除、不可撤销。
          它是 AI 的产出，重新诊断可以再生成一份。
        </p>
      ) : null}

      <ReportCard report={shown} />
    </div>
  );
}
