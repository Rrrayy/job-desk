/**
 * `image` 字段（`PhotoField`）—— **本任务只落接口占位**。
 *
 * 主理人裁决（Q8 修正版）：8 套模板全做，照片只对 `creative` 生效（≤480px / ≤80 KB）。
 * T02 的基座 schema 不含 `image` 字段，所以这个控件当前**不会被任何模板渲染**；
 * 保留它是为了让 `SchemaForm` 的 `image` 分支与接口一次定型，T04 落压缩时
 * 只需替换本文件内部实现，不动调用方。
 *
 * ★ 不静默降级：按钮明确写「随 creative 提供 · 本版未启用」，而不是渲染一个
 * 点了没反应的「上传照片」。用户看到的必须是真话（ARCH Q8 附则）。
 */

export interface PhotoFieldProps {
  label: string;
  /** data URL（`data:image/jpeg;base64,…`；`check-no-network` 只拦 http(s)，data: 合规） */
  value: string;
  onChange: (dataUrl: string) => void;
  hint?: string;
}

const NOT_YET = '照片上传随 creative 模板一起提供，本版暂未启用';

export function PhotoField(props: PhotoFieldProps) {
  const { label, value, onChange, hint } = props;
  return (
    <div className="photo">
      <span className="field__label">{label}</span>
      <div className="photo__row">
        {value ? <img className="photo__preview" src={value} alt={label} /> : null}
        <button type="button" className="btn btn--tiny" disabled aria-label={`${label}：选择图片（暂未启用）`}>
          选择图片
        </button>
        {value ? (
          // 导入来的照片必须能删掉 —— 这是本版唯一真正可用的照片操作
          <button type="button" className="btn btn--tiny btn--danger-ghost" onClick={() => onChange('')}>
            移除照片
          </button>
        ) : null}
      </div>
      {hint ? <span className="field__hint">{hint}</span> : null}
      <span className="field__hint">{NOT_YET}</span>
    </div>
  );
}
