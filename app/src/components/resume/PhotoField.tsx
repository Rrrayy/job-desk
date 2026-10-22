/**
 * `image` 字段（`PhotoField`）—— T04 起真正可用，但**只有 `creative` 会渲染它**。
 *
 * 交互：选择图片 → `compressPhoto` 读文件即压缩（宽 ≤480px、单张 ≤80 KB）→
 * 成功写入 data URL，失败在按钮下方显示**具体原因**（不是「上传失败」）。
 *
 * 三条刻意的设计：
 * 1. **不静默降级**（ARCH Q8 附则）：环境不支持压缩就明说「暂时传不了照片」，
 *    而不是给一个点了没反应的按钮；
 * 2. 服务端没有、网络也没有 —— 数据 URL 直接进 `fields.photo`，
 *    `@media print` 下的 `<img>` 与屏幕上看到的是同一个字节序列；
 * 3. 已导入的照片永远能删掉（导入/导出/历史数据里可能带着别人的照片）。
 */

import { useRef, useState } from 'react';
import { compressPhoto, PHOTO_MAX_BYTES, PHOTO_MAX_WIDTH, PHOTO_UNSUPPORTED } from '../../resume/photo';

export interface PhotoFieldProps {
  label: string;
  /** data URL（`data:image/jpeg;base64,…`；`check-no-network` 只拦 http(s)，data: 合规） */
  value: string;
  onChange: (dataUrl: string) => void;
  hint?: string;
}

export function PhotoField(props: PhotoFieldProps) {
  const { label, value, onChange, hint } = props;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = (): void => {
    setError(null);
    inputRef.current?.click();
  };

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const result = await compressPhoto(file);
      if (result.ok) onChange(result.dataUrl);
      else setError(result.reason);
    } catch {
      // compressPhoto 本身不抛；这里兜的是「浏览器 API 抛了意外异常」这一类
      setError(PHOTO_UNSUPPORTED);
    } finally {
      setBusy(false);
      // 允许连续选同一张图（不清空的话 change 不会再次触发）
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="photo">
      <span className="field__label">{label}</span>
      <div className="photo__row">
        {value ? <img className="photo__preview" src={value} alt={label} /> : null}
        <input
          ref={inputRef}
          className="photo__input"
          type="file"
          accept="image/*"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            void onFile(event.target.files?.[0]);
          }}
        />
        <button
          type="button"
          className="btn btn--tiny"
          aria-label={`${label}：选择图片`}
          disabled={busy}
          onClick={pick}
        >
          {busy ? '处理中…' : value ? '换一张' : '选择图片'}
        </button>
        {value ? (
          <button
            type="button"
            className="btn btn--tiny btn--danger-ghost"
            aria-label={`${label}：移除照片`}
            onClick={() => {
              setError(null);
              onChange('');
            }}
          >
            移除
          </button>
        ) : null}
      </div>
      {hint ? <span className="field__hint">{hint}</span> : null}
      <span className="field__hint">
        自动压到宽 ≤{PHOTO_MAX_WIDTH}px、≤{Math.round(PHOTO_MAX_BYTES / 1024)} KB（只存在你自己的浏览器里）
      </span>
      {error ? <span className="field__hint field__hint--danger">{error}</span> : null}
    </div>
  );
}
