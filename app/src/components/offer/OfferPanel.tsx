/**
 * 模块一 · Offer 决策面板（一级浮层，从今日卡 / 看板列头进入）。
 *
 * 面板结构 = 结论先行：提醒 → 对比表 → 权重 → 决策。
 * 权重放在对比表**下面**是故意的：先让用户看清「分差从哪来」，再允许他调权重。
 * 先调权重会变成「先决定结论再挑理由」，那是自欺。
 */

import { useMemo, useState } from 'react';
import type { AppApi } from '../../lib/api';
import {
  buildCompareRows,
  buildOfferAlerts,
  defaultSelection,
  toggleSelection,
} from '../../lib/offer/compare';
import { decisionToMarkdown } from '../../lib/offer/decision';
import { copyText, cx } from '../../lib/util';
import { CLS } from '../../lib/classTokens';
import { CompareTable } from './CompareTable';
import { DecisionForm } from './DecisionForm';
import { WeightPanel } from './WeightPanel';

export function OfferPanel({ api, onClose }: { api: AppApi; onClose: () => void }) {
  const { db, now } = api;
  const candidates = api.offer.candidates;
  const weights = api.offer.weights;

  /**
   * 默认全选；超过 8 个时按 offer 最近编辑取前 8 个，并把被挤掉的条数说出来 ——
   * 静默只显示 8 个会让人以为「工具漏了我的 offer」。
   */
  const initial = useMemo(() => defaultSelection(candidates), [candidates]);
  const [selectedIds, setSelectedIds] = useState<string[]>(initial.ids);
  const [rejectedHint, setRejectedHint] = useState(false);

  const selected = candidates.filter((item) => selectedIds.includes(item.app.id));
  const rows = useMemo(() => buildCompareRows(selected, weights), [selected, weights]);
  const alerts = useMemo(() => buildOfferAlerts(candidates, db.settings, now), [candidates, db.settings, now]);
  // App 层已经算好视图（含悬空兜底），这里不再重算一遍 —— 重算会让「投递已删除」的标签丢掉
  const view = api.offer.decision;

  const onToggle = (id: string): void => {
    const outcome = toggleSelection(selectedIds, id);
    setSelectedIds(outcome.ids);
    setRejectedHint(outcome.rejected);
  };

  const exportMarkdown = async (): Promise<void> => {
    if (!view) return;
    const markdown = decisionToMarkdown({ view, rows, weights });
    const ok = await copyText(markdown);
    api.toast(ok ? '已复制 Markdown，粘到笔记里就是一份留档' : '复制失败，请手动选中文本');
  };

  return (
    <div className={CLS.U} onClick={onClose}>
      <div className="modal modal--offer" onClick={(event) => event.stopPropagation()}>
        <header className={CLS.ac}>
          <h2 className={CLS.Y}>Offer 决策</h2>
          <button type="button" className={CLS.m} onClick={onClose} title="关闭（Esc）" aria-label="关闭">
            ✕
          </button>
        </header>

        <div className={CLS.aa}>
          {candidates.length === 0 ? (
            <div className={CLS.C}>
              <div className={CLS.y}>⚖️</div>
              <h3 className={CLS.z}>还没有任何 Offer</h3>
              <p className={CLS.A}>
                把投递状态改成「已 Offer」之后，这里会自动出现对比表 —— 口头 offer 也能先记。
              </p>
            </div>
          ) : (
            <>
              {alerts.length > 0 ? (
                <ul className="offer-alerts" data-testid="offer-alerts">
                  {alerts.map((alert) => (
                    <li
                      key={`${alert.kind}-${alert.appId}`}
                      className={cx('offer-alerts__item', alert.tone === 'warn' ? 'is-warn' : undefined)}
                    >
                      {alert.kind === 'deadline' ? '⏰ ' : '◻︎ '}
                      {alert.text}
                      <button type="button" className={CLS.k} onClick={() => api.openDetail(alert.appId)}>
                        去看看
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}

              <CompareTable
                candidates={candidates}
                selectedIds={selectedIds}
                rows={rows}
                overflow={initial.overflow}
                onToggle={onToggle}
              />
              {rejectedHint ? (
                <p className={CLS.s} role="alert">
                  最多同时对比 8 个。想换一个进来，先勾掉一个。
                </p>
              ) : null}

              <WeightPanel weights={weights} onCommit={api.offer.setWeights} />

              <DecisionForm api={api} candidates={candidates} view={view} />

              {view ? (
                <div className={CLS.r}>
                  <button type="button" className={CLS.b} onClick={() => void exportMarkdown()}>
                    导出这份决策（Markdown）
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>

        <footer className={CLS.ab}>
          <span className={CLS.c}>本地加权计算，仅供参考 —— 分数帮你排清偏好，不替你做决定。</span>
          <div className="modal__actions">
            <button type="button" className="btn" onClick={onClose}>
              关掉
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
