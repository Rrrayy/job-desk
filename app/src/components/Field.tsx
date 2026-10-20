/** 通用表单控件：输入即改、失焦提交，避免整页表单带来的心理负担。 */

import { useEffect, useState } from 'react';
import { cx, orDash } from '../lib/util';

export interface FieldProps {
  label?: string;
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  type?: 'text' | 'date' | 'url' | 'number' | 'time' | 'datetime-local';
  hint?: string;
  disabled?: boolean;
  min?: number;
  max?: number;
  narrow?: boolean;
}

/** 文本类字段：本地暂存，失焦或回车时提交 */
export function Field(props: FieldProps) {
  const { label, value, onCommit, placeholder, type = 'text', hint, disabled, min, max, narrow } = props;
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = (): void => {
    if (draft !== value) onCommit(draft);
  };

  return (
    <label className={cx('field', narrow && 'field--narrow')}>
      {label ? <span className="field__label">{label}</span> : null}
      <input
        className="input"
        type={type}
        value={draft}
        min={min}
        max={max}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      {hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export interface SelectFieldProps<T extends string> {
  label?: string;
  value: T | '';
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  placeholder?: string;
  narrow?: boolean;
}

/** 下拉字段：选中即生效 */
export function SelectField<T extends string>(props: SelectFieldProps<T>) {
  const { label, value, options, onChange, placeholder = '请选择', narrow } = props;
  return (
    <label className={cx('field', narrow && 'field--narrow')}>
      {label ? <span className="field__label">{label}</span> : null}
      <select
        className="select"
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {value === '' ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** 只读的信息行 */
export function InfoRow({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div className="inforow">
      <span className="inforow__label">{label}</span>
      <span className="inforow__value">{orDash(value)}</span>
    </div>
  );
}
