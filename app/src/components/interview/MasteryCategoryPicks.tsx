/**
 * 掌握度 + 分类两个下拉（v0.9 / T-QB ①②③ 共用）。
 *
 * 为什么抽成组件：快记行内、题库行内编辑、将来 T07b 的整段录入预览都要这两个选择。
 * option 列表在这里只写一遍 —— 三处各写一遍，迟早会有一处忘了加新类别。
 *
 * 两种形态：
 * - `variant="inline"`：行内小号，无可见标签（靠 aria-label），宽度不撑高弹层；
 * - `variant="form"`：表单号，带 field__label 可见标签（编辑态用）。
 *
 * 选中的值由父组件持有 —— 快记一行还没落库，改的是本地选择；编辑态改的是草稿。
 */

import type { Mastery, QuestionCategory } from '../../types';
import { CATEGORY_LABEL, CATEGORY_NONE_LABEL, CATEGORY_OPTIONS, MASTERY_LABEL } from '../../lib/interview';

const MASTERY_OPTIONS: Mastery[] = [0, 1, 2];

export interface MasteryCategoryPicksProps {
  mastery: Mastery;
  category: QuestionCategory | null;
  /** 只回调改动的那个字段，父组件用对象展开写回 */
  onChange: (patch: { mastery?: Mastery; category?: QuestionCategory | null }) => void;
  variant?: 'inline' | 'form';
  disabled?: boolean;
  /** 同一个浮层里多行时用来区分 aria-label（如「第 3 题」） */
  labelPrefix?: string;
}

export function MasteryCategoryPicks(props: MasteryCategoryPicksProps) {
  const { mastery, category, onChange, variant = 'inline', disabled = false, labelPrefix } = props;
  const compact = variant === 'inline';
  const masteryName = labelPrefix ? `${labelPrefix}掌握度` : '掌握度';
  const categoryName = labelPrefix ? `${labelPrefix}分类` : '分类';

  const masterySelect = (
    <select
      className={compact ? 'select select--compact' : 'select'}
      value={String(mastery)}
      aria-label={masteryName}
      disabled={disabled}
      onChange={(event) => onChange({ mastery: Number(event.target.value) as Mastery })}
    >
      {MASTERY_OPTIONS.map((item) => (
        <option key={item} value={String(item)}>
          {MASTERY_LABEL[item]}
        </option>
      ))}
    </select>
  );

  const categorySelect = (
    <select
      className={compact ? 'select select--compact' : 'select'}
      value={category ?? ''}
      aria-label={categoryName}
      disabled={disabled}
      onChange={(event) => {
        const value = event.target.value;
        onChange({ category: value === '' ? null : (value as QuestionCategory) });
      }}
    >
      <option value="">{CATEGORY_NONE_LABEL}</option>
      {CATEGORY_OPTIONS.map((item) => (
        <option key={item} value={item}>
          {CATEGORY_LABEL[item]}
        </option>
      ))}
    </select>
  );

  if (compact) {
    return (
      <span className="picks picks--inline">
        {masterySelect}
        {categorySelect}
      </span>
    );
  }

  return (
    <div className="picks picks--form">
      <label className="field">
        <span className="field__label">掌握度</span>
        {masterySelect}
      </label>
      <label className="field">
        <span className="field__label">分类</span>
        {categorySelect}
      </label>
    </div>
  );
}
