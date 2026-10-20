/**
 * ① 抓取：粘贴区（200px）+ 拖入文件 + 扩展提示。
 * 扩展信封会被 lib/sync/capture.ts 自动识别，和手动 Ctrl+V 走同一条代码路径。
 */

import { useRef, useState } from 'react';
import type { PlatformId } from '../../types';
import { PLATFORM_LABEL } from '../../adapters/registry';
import { MAX_CAPTURE_FILE_BYTES, readTextFile } from '../../lib/sync/capture';
import { cx } from '../../lib/util';

export interface Step1CaptureProps {
  text: string;
  onText: (value: string) => void;
  platform: PlatformId;
  onPlatform: (value: PlatformId) => void;
  onParse: () => void;
  parsing: boolean;
  error: string | null;
  /** 上一次解析出的统计，用于显示「识别 N 条 · 置信度高x/中x/低x」 */
  summary: { total: number; high: number; medium: number; low: number } | null;
  riskAckAt?: string;
}

const PLATFORMS: PlatformId[] = ['boss', 'shixiseng', 'nowcoder', 'custom'];

export function Step1Capture(props: Step1CaptureProps) {
  const { text, onText, platform, onPlatform, onParse, parsing, error, summary } = props;
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const readFile = async (file: File): Promise<void> => {
    setFileError(null);
    if (file.size > MAX_CAPTURE_FILE_BYTES) {
      setFileError('文件超过 2 MB，看起来不像一整页的页面文本');
      return;
    }
    try {
      const content = await readTextFile(file);
      onText(content);
    } catch (err) {
      setFileError(err instanceof Error ? err.message : '读取文件失败');
    }
  };

  return (
    <section className="sync__step">
      <div className="sync__step-head">
        <h3 className="sync__step-title">① 抓取</h3>
        <label className="sync__platform">
          <span className="field__label">平台</span>
          <select
            className="select select--compact"
            value={platform}
            onChange={(event) => onPlatform(event.target.value as PlatformId)}
          >
            {PLATFORMS.map((id) => (
              <option key={id} value={id}>
                {PLATFORM_LABEL[id]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="sync__hint">
        把 BOSS「沟通中 / 已投递」列表<strong>整页复制</strong>过来（Ctrl+A → Ctrl+C → 这里 Ctrl+V），
        或把扩展抓下来的内容直接粘贴进来，也可以拖入一个 <code>.json</code> / <code>.txt</code> 文件。
      </p>

      <div
        className={cx('sync__drop', dragging && 'is-dragging')}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files && event.dataTransfer.files[0];
          if (file) void readFile(file);
        }}
      >
        <textarea
          className="sync__textarea"
          value={text}
          placeholder="在这里粘贴页面内容 —— 内容不会被上传，只在本地解析"
          onChange={(event) => onText(event.target.value)}
          spellCheck={false}
        />
        {text.trim().length === 0 ? (
          <span className="sync__drop-hint">把文件拖到这里也可以</span>
        ) : null}
      </div>

      <div className="sync__row">
        <button type="button" className="btn btn--small" onClick={() => fileRef.current?.click()}>
          选择文件
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.txt,text/plain,application/json"
          className="hidden-file"
          onChange={(event) => {
            const file = event.target.files && event.target.files[0];
            if (file) void readFile(file);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          className="btn btn--small btn--primary"
          onClick={onParse}
          disabled={parsing || text.trim().length === 0}
        >
          {parsing ? '解析中…' : '解析'}
        </button>
        {summary ? (
          <span className="sync__summary">
            识别 <strong>{summary.total}</strong> 条 · 置信度 高 {summary.high} / 中 {summary.medium} / 低{' '}
            {summary.low}
          </span>
        ) : null}
      </div>

      {fileError ? <div className="notice notice--danger">{fileError}</div> : null}
      {error ? <div className="notice notice--danger">{error}</div> : null}

      <div className="sync__ext">
        <strong>扩展通道（可选）</strong>
        <p>
          装好 <code>extension/</code> 里的 MV3 扩展后，在 BOSS 列表页点扩展图标 →「抓取本页并复制」，
          再回到这里按 Ctrl+V。扩展只读你屏幕上已经能看到的内容，只申请 <code>activeTab</code> +{' '}
          <code>scripting</code>，不申请任何域名权限。
        </p>
        <p className="muted">
          抓不到时的建议：先用 Ctrl+A / Ctrl+C 整页复制（这条路径永远可用），或修改
          <code> extension/selectors.json </code> 里的选择器。
        </p>
      </div>
    </section>
  );
}
