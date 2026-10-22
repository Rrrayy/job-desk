/**
 * 暂存区列表：「待归类」的记录落在这里，用户可以逐条给它定状态，或全体忽略。
 *
 * 为什么要有这一屏：解析/映射失败的条目**绝不静默丢弃**（PRD §B.9 P0）。
 * 只要平台页面上有这条记录，用户就必须能在工作台里看到它、处理它。
 */

import { useMemo, useState } from 'react';
import type { Status, StagedSyncItem } from '../../types';
import { ALL_STATUSES, STATUS_LABEL } from '../../lib/rules';
import { PLATFORM_LABEL } from '../../adapters/registry';
import { STAGING_LIMIT } from '../../lib/sync/engine';
import { copyText } from '../../lib/util';

export interface StagingListProps {
  items: StagedSyncItem[];
  onResolve: (stagedId: string, status: Status | null) => void;
  onClear: () => void;
  /** 「解析失败」的行没法自动归位：给一个入口把它手动补成一条投递（QA D1） */
  onManualAdd?: () => void;
  /** 暂存区上限（默认取引擎常量），用于「快满了」提示 */
  limit?: number;
  /**
   * v0.8 / D17：AI 兜底解析入口。**只对 unparsed / unmapped 行出现** ——
   * ambiguous 与 conflict 行缺的不是「认字」而是「你的判断」，模型帮不上忙。
   */
  onAiRetry?: (item: StagedSyncItem) => void;
  /** AI 是否已配置；false 时按钮置灰 + 列表顶部一句内联原因（R-AI-5） */
  aiReady?: boolean;
  aiReason?: string | null;
}

const REASON_TEXT: Record<StagedSyncItem['reason'], string> = {
  unmapped: '状态没认出来',
  ambiguous: '有多个疑似同公司同岗位',
  conflict: '与你的判断冲突',
  unparsed: '这一段没解析出来',
};

export function StagingList(props: StagingListProps) {
  const { items, onResolve, onClear, onManualAdd, limit = STAGING_LIMIT, onAiRetry, aiReady = false, aiReason } = props;
  const [confirmClear, setConfirmClear] = useState(false);
  /** 每行选中的目标状态（默认 applied：最常见的「其实我已经投了」） */
  const [picked, setPicked] = useState<Record<string, Status>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  /**
   * 🤖 AI 重试解析按钮。出境内容 = 这一行的原文（D17 铁律），
   * 所以原文缺失时按钮禁用 —— 没有原文就没有可发的东西。
   */
  const aiButton = (item: StagedSyncItem): JSX.Element | null => {
    if (!onAiRetry || (item.reason !== 'unparsed' && item.reason !== 'unmapped')) return null;
    const raw = item.rawSnippet ?? item.parsed.rawSnippet ?? '';
    const hint = aiReady ? (raw.length > 0 ? '只发这段原文，不含库内任何数据' : '这条没有留下原文，没法重试') : aiReason ?? 'AI 未配置';
    return (
      <button
        type="button"
        className="btn btn--small"
        data-testid={`ai-retry-${item.id}`}
        disabled={!aiReady || raw.length === 0}
        title={hint}
        onClick={() => onAiRetry(item)}
      >
        🤖 用 AI 重试解析
      </button>
    );
  };

  const ordered = useMemo(
    () => [...items].sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : 0)),
    [items],
  );

  if (items.length === 0) {
    return (
      <section className="sync__step">
        <div className="sync__step-head">
          <h3 className="sync__step-title">暂存区</h3>
        </div>
        <div className="empty-block">
          <div className="empty-block__emoji">🗂</div>
          <div className="empty-block__title">没有待归类的记录</div>
          <p className="empty-block__text">
            同步时没能自动判定的记录会放在这里 —— 一条都不会丢，只是需要你告诉它属于哪个阶段。
          </p>
        </div>
      </section>
    );
  }

  const nearlyFull = items.length >= Math.floor(limit * 0.9);

  return (
    <section className="sync__step">
      <div className="sync__step-head">
        <h3 className="sync__step-title">暂存区（{items.length}）</h3>
        <div className="sync__staging-actions">
          {confirmClear ? (
            <>
              <span className="muted">确认丢掉全部 {items.length} 条？</span>
              <button
                type="button"
                className="btn btn--small btn--danger"
                onClick={() => {
                  onClear();
                  setConfirmClear(false);
                }}
              >
                确认忽略
              </button>
              <button type="button" className="btn btn--small" onClick={() => setConfirmClear(false)}>
                取消
              </button>
            </>
          ) : (
            <button type="button" className="btn btn--small" onClick={() => setConfirmClear(true)}>
              全部忽略
            </button>
          )}
        </div>
      </div>

      {nearlyFull ? (
        <div className="notice notice--warn">
          暂存区上限 {limit} 条，当前已 {items.length} 条。超过上限时会自动丢弃最旧的（会提示条数），
          建议先把旧的清掉。
        </div>
      ) : null}

      {onAiRetry && !aiReady ? (
        <p className="field__hint" data-testid="ai-staging-blocked">
          「用 AI 重试解析」暂时置灰：{aiReason ?? 'AI 服务未配置'}。置灰不等于报错 —— 配好之后这些行原样还在。
        </p>
      ) : null}

      <ul className="sync__staging-list">
        {ordered.map((item) => {
          // 「没解析出来」的行没公司名也没岗位名，给不了状态下拉 —— 那样只会
          // 顺手建出一条「未知公司」。这里只给：看原文 / 复制原文 / 手动补录 / 忽略。
          if (item.reason === 'unparsed') {
            const snippet = item.rawSnippet ?? item.parsed.rawSnippet ?? '';
            return (
              <li key={item.id} className="sync__staging-item sync__staging-item--unparsed">
                <div className="sync__staging-head">
                  <span className="sync__staging-company sync__staging-company--unknown">（没解析出公司名）</span>
                  <span className="sync__badge sync__badge--staged">{REASON_TEXT[item.reason]}</span>
                  <span className="sync__source">
                    {PLATFORM_LABEL[item.platform]} · {isoMinute(item.capturedAt)}
                  </span>
                </div>

                <pre className="sync__staging-snippet">{snippet || '（原文片段已丢失）'}</pre>

                <div className="sync__staging-raw">
                  {item.reasonText ? `为什么没认出来：${item.reasonText}` : '没能从这一段里认出公司、岗位和状态。'}
                </div>

                <div className="sync__staging-controls">
                  {aiButton(item)}
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={snippet.length === 0}
                    onClick={() => {
                      void copyText(snippet).then((ok) => setCopiedId(ok ? item.id : null));
                    }}
                  >
                    {copiedId === item.id ? '已复制 ✓' : '复制原文'}
                  </button>
                  {onManualAdd ? (
                    <button type="button" className="btn btn--small btn--primary" onClick={onManualAdd}>
                      手动补录一条
                    </button>
                  ) : null}
                  <button type="button" className="btn btn--small" onClick={() => onResolve(item.id, null)}>
                    忽略这条
                  </button>
                </div>
              </li>
            );
          }

          const target = picked[item.id] ?? 'applied';
          return (
            <li key={item.id} className="sync__staging-item">
              <div className="sync__staging-head">
                <span className="sync__staging-company">{item.parsed.companyName || '（没抓到公司名）'}</span>
                <span className="sync__badge sync__badge--staged">{REASON_TEXT[item.reason]}</span>
                <span className="sync__source">
                  {PLATFORM_LABEL[item.platform]} · {isoMinute(item.capturedAt)}
                </span>
              </div>

              <div className="sync__staging-job">{item.parsed.jobTitle || '（没抓到岗位名）'}</div>

              {item.platformStatusRaw ? (
                <div className="sync__staging-raw">
                  平台原文状态：<q>{item.platformStatusRaw}</q>
                </div>
              ) : null}

              {item.candidateAppId ? (
                <div className="sync__staging-raw">
                  疑似已有投递（id 尾号 {item.candidateAppId.slice(-4)}）—— 也可以直接忽略，稍后在列表里手工合并。
                </div>
              ) : null}

              <div className="sync__staging-controls">
                {aiButton(item)}
                <label className="sync__staging-pick">
                  <span className="field__label">归到</span>
                  <select
                    className="select select--compact"
                    value={target}
                    onChange={(event) => setPicked((prev) => ({ ...prev, [item.id]: event.target.value as Status }))}
                  >
                    {ALL_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {STATUS_LABEL[status]}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="btn btn--small btn--primary"
                  onClick={() => onResolve(item.id, target)}
                >
                  确认归到「{STATUS_LABEL[target]}」
                </button>
                <button type="button" className="btn btn--small" onClick={() => onResolve(item.id, null)}>
                  忽略这条
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function isoMinute(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value));
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
