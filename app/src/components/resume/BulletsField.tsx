/**
 * `rich_bullets` 字段（ARCH A-06：5 种字段类型只新写 3 个组件，这是第 1 个）。
 *
 * 每行一个要点，可增删、可上下移 —— **不支持随意排版**（PRD §8.3：这不是富文本编辑器）。
 * 三条实现取舍：
 * 1. 行是 `<textarea>` 不是 contenteditable：contenteditable 会引入粘贴富文本、
 *    回车插 `<div>`、撤销栈与 `⌘Z` 打架三件事，而「每行一个要点」根本不需要它们。
 * 2. 数据是 `string[]`（`ResumeItem.bullets`），不是「一个 key 里塞多行文本」——
 *    前者上下移序只是数组换位，后者要解析文本，切模板时必错。
 * 3. `value` 为空时**渲染一行空行**：否则用户点「+ 加一条」后看不到任何新控件，
 *    以为按钮坏了。空行不落库由 `cleanBullets` 在读的一侧兜（见 resume/schema.ts）。
 */

export interface BulletsFieldProps {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  hint?: string;
}

/** 数组换位（越界时返回原数组，调用方据此判断「按钮点不动」） */
function moved(list: string[], from: number, to: number): string[] {
  if (to < 0 || to >= list.length) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function BulletsField(props: BulletsFieldProps) {
  const { label, value, onChange, placeholder, hint } = props;
  // 空数组也画一行：用户点「加一条」后必须立刻看到可输入的控件
  const rows = value.length > 0 ? value : [''];

  const setAt = (index: number, text: string): void => {
    const next = value.slice();
    next[index] = text;
    onChange(next);
  };

  const removeAt = (index: number): void => {
    onChange(value.filter((_, i) => i !== index));
  };

  return (
    <div className="bullets">
      <span className="field__label">{label}</span>
      <div className="bullets__rows">
        {rows.map((line, index) => (
          <div className="bullets__row" key={index}>
            <textarea
              className="textarea bullets__text"
              value={line}
              aria-label={`第 ${index + 1} 条要点`}
              placeholder={index === 0 ? placeholder : undefined}
              onChange={(event) => setAt(index, event.target.value)}
            />
            <div className="bullets__acts">
              <button
                type="button"
                className="btn btn--tiny"
                aria-label={`上移第 ${index + 1} 条要点`}
                disabled={index === 0}
                onClick={() => onChange(moved(value, index, index - 1))}
              >
                ↑
              </button>
              <button
                type="button"
                className="btn btn--tiny"
                aria-label={`下移第 ${index + 1} 条要点`}
                disabled={index >= value.length - 1}
                onClick={() => onChange(moved(value, index, index + 1))}
              >
                ↓
              </button>
              <button
                type="button"
                className="btn btn--tiny btn--danger-ghost"
                aria-label={`删除第 ${index + 1} 条要点`}
                onClick={() => removeAt(index)}
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="bullets__foot">
        <button
          type="button"
          className="btn btn--tiny"
          // 空数组时那行「空行」只存在于渲染里，不在数据里：再点「加一条」必须
          // 先把这行坐实，否则用户看到的是「怎么点都没反应」（`[...[], '']` = `['']` = 还是一行）
          onClick={() => onChange([...(value.length > 0 ? value : ['']), ''])}
        >
          + 加一条要点
        </button>
        {hint ? <span className="field__hint">{hint}</span> : null}
      </div>
    </div>
  );
}
