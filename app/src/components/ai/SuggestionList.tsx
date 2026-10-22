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
  onAccept: (ids: string[]) => void;
  onReject: (ids: string[]) => void;
  emptyText?: string;
}

export function SuggestionList(props: SuggestionListProps): JSX.Element {
  const { suggestions, evidence = false, onAccept, onReject, emptyText = '暂无 AI 建议' } = props;
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
    return <p className="field__hint" data-testid="suggestion-empty">{emptyText}</p>;
  }

  return (
    <div data-testid="suggestion-list">
      <label className="field">
        <input
          type="checkbox"
          checked={allSelected}
          data-testid="suggestion-select-all"
          onChange={(event) => toggleAll(event.target.checked)}
        />
        <span className="field__label">全选（{selected.size}/{suggestions.length}）</span>
      </label>
      {suggestions.map((suggestion) => (
        <div key={suggestion.id} className="field" data-testid={`suggestion-${suggestion.id}`}>
          <label>
            <input
              type="checkbox"
              checked={selected.has(suggestion.id)}
              onChange={(event) => toggle(suggestion.id, event.target.checked)}
            />
            <span className="field__label">
              【{TARGET_LABEL[suggestion.targetType]}·{suggestion.fieldPath}】{suggestion.content}
            </span>
          </label>
          {evidence && suggestion.evidence ? (
            <span className="field__hint">证据：{suggestion.evidence}</span>
          ) : null}
        </div>
      ))}
      <div className="drawer__actions">
        <button
          type="button"
          className="btn btn--primary"
          data-testid="suggestion-accept"
          disabled={selected.size === 0}
          onClick={() => confirm('accept')}
        >
          接受所选
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          data-testid="suggestion-reject"
          disabled={selected.size === 0}
          onClick={() => confirm('reject')}
        >
          忽略所选
        </button>
      </div>
    </div>
  );
}
