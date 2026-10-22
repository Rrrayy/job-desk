/**
 * `tags` 字段（ARCH A-06 第 2 个新组件，薄壳）。
 *
 * 数据侧**不引入标签数据结构**：`ResumeItem.fields[key]` 依旧是一个逗号串。
 * 这是「数据是超集」的实现基础 —— `Record<string, string>` 让任意模板的任意字段
 * 都能原样存回去，切模板不需要任何 migration。解析成数组只发生在**读**的时候
 * （`parseTags`），预览与 AI 出境都是读方。
 *
 * 交互取舍：输入时原样存（打「React, 」不会被打断），失焦时才规范化成
 * 「React, TypeScript」（去重、半角逗号、单空格）。边打边规范化会在用户
 * 刚敲完逗号时把光标推走。
 */

import { useEffect, useState } from 'react';
import { formatTags, parseTags } from '../../resume/schema';

export interface TagsFieldProps {
  label: string;
  /** 逗号串（库里的原值） */
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  hint?: string;
}

export function TagsField(props: TagsFieldProps) {
  const { label, value, onChange, placeholder, hint } = props;
  const tags = parseTags(value);

  // 与 Field.tsx 同一套写法：本地暂存原文本，失焦提交规范化结果
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = (): void => {
    const next = formatTags(draft);
    setDraft(next);
    if (next !== value) onChange(next);
  };

  return (
    <div className="tags">
      <label className="field">
        <span className="field__label">{label}</span>
        <input
          className="input"
          type="text"
          value={draft}
          placeholder={placeholder}
          onChange={(event) => {
            setDraft(event.target.value);
            // 边打边写回：预览不等失焦（验收 6），防抖通道负责合并写盘
            onChange(event.target.value);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
      </label>
      {tags.length > 0 ? (
        <div className="tags__chips" aria-label={`${label}（${tags.length} 个标签）`}>
          {tags.map((tag) => (
            <span className="tags__chip" key={tag}>
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      {hint ? <span className="field__hint">{hint}</span> : null}
    </div>
  );
}
