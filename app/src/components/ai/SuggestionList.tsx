/**
 * SuggestionList（v0.8 / T03）：AI 建议的勾选与决策区。
 *
 * 逐条勾选 → 接受（走 api.ai.acceptSuggestions，单次 mutate + 一个撤销点）
 * / 忽略（rejected，留 7 天后 sweep 清理）。D17 场景传 evidence=true
 * 展示证据对照（原文片段 vs 建议值）。
 *
 * 组件是纯展示：不碰库、不发请求，回调只在用户明确点击时触发。
 */

import { useState } from 'react';
import type { AISuggestion, AISuggestionTargetType } from '../../ai/types';
import { CLS } from '../../lib/classTokens';

const TARGET_LABEL: Record<AISuggestionTargetType, string> = {
  question: '新题',
  application_note: '话术草稿',
  staging_field: '字段补全',
  resume_field: '简历字段',
};

export interface SuggestionListProps {
  suggestions: AISuggestion[];
  /** 展示证据对照（D17） */
  evidence?: boolean;
  /**
   * v0.10 / L3-6：取「这条建议要替换的原值」。
   * 给了就并排显示 diff（删除线原文 → 建议值）；给不出就不显示 —— 不猜。
   * 由调用方决定（只有它知道 targetId 指向哪一行）。
   */
  originalOf?: (suggestion: AISuggestion) => string | undefined;
  onAccept: (ids: string[]) => void;
  onReject: (ids: string[]) => void;
  emptyText?: string;
}

export function SuggestionList(props: SuggestionListProps): JSX.Element {
  const { suggestions, evidence = false, originalOf, onAccept, onReject, emptyText = '暂无 AI 建议' } = props;
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = (id: string, next: boolean): void => {
    setSelected((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  };

  const toggleAll = (next: boolean): void => {
    setSelected(next ? new Set(suggestions.map((item) => item.id)) : new Set());
  };

  const confirm = (action: 'accept' | 'reject'): void => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setSelected(new Set());
    if (action === 'accept') onAccept(ids);
    else onReject(ids);
  };

  const allSelected = suggestions.length > 0 && selected.size === suggestions.length;

  if (suggestions.length === 0) {
    return <p className={CLS.c} data-testid="suggestion-empty">{emptyText}</p>;
  }

  return (
    <div data-testid="suggestion-list">
      <label className={CLS.g}>
        <input
          type="checkbox"
          checked={allSelected}
          data-testid="suggestion-select-all"
          onChange={(event) => toggleAll(event.target.checked)}
        />
        <span className={CLS.a}>全选（{selected.size}/{suggestions.length}）</span>
      </label>
      {suggestions.map((suggestion) => {
        // 原值只做展示：内容为空/与建议相同时不画 diff（噪音）
        const original = originalOf?.(suggestion);
        const showDiff = typeof original === 'string' && original.trim().length > 0 && original.trim() !== suggestion.content.trim();
        return (
          <div key={suggestion.id} className={CLS.g} data-testid={`suggestion-${suggestion.id}`}>
            <label>
              <input
                type="checkbox"
                checked={selected.has(suggestion.id)}
                onChange={(event) => toggle(suggestion.id, event.target.checked)}
              />
              <span className={CLS.a}>
                【{TARGET_LABEL[suggestion.targetType]}·{suggestion.fieldPath}】{suggestion.content}
              </span>
            </label>
            {showDiff ? (
              <p className="suggestion-diff" data-testid={`suggestion-diff-${suggestion.id}`}>
                <span className="suggestion-diff__old">{original}</span>
                <span className="suggestion-diff__arrow">→</span>
              </p>
            ) : null}
            {evidence && suggestion.evidence ? (
              <span className={CLS.c}>证据：{suggestion.evidence}</span>
            ) : null}
          </div>
        );
      })}
      <div className={CLS.p}>
        <button
          type="button"
          className={CLS.j}
          data-testid="suggestion-accept"
          disabled={selected.size === 0}
          onClick={() => confirm('accept')}
        >
          接受所选
        </button>
        <button
          type="button"
          className={CLS.Q}
          data-testid="suggestion-reject"
          disabled={selected.size === 0}
          onClick={() => confirm('reject')}
        >
          忽略所选
        </button>
        {/* v0.10 / L3-6：一次把这一屏都清掉（忽略不是删除，7 天后才清理） */}
        <button
          type="button"
          className={CLS.k}
          data-testid="suggestion-reject-all"
          onClick={() => {
            setSelected(new Set());
            onReject(suggestions.map((item) => item.id));
          }}
        >
          全部忽略（{suggestions.length}）
        </button>
      </div>
    </div>
  );
}
