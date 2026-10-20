/**
 * 社区题库导入（P1）：拖入 / 选择一份**你已经下载到本地**的社区面经 JSON。
 *
 * 为什么不做「一键联网拉取」：这个产品的卖点之一是「零网络请求」。
 * 一旦加了自动拉取，浏览器里的任何一次打开都可能带着请求出去，隐私承诺就变成一句口号。
 * 所以这里只做「本地文件 → 预览 → 去重合并」，拉取动作交给用户的浏览器（他自己点下载）。
 */

import { useRef, useState } from 'react';
import type { AppApi } from '../../lib/api';

export function CommunityImport({ api }: { api: AppApi }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const communityCount = api.db.experiences.filter((item) => item.source === 'community').length;

  const handleFile = (file: File | undefined): void => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.json')) {
      setError('只接受 .json 文件（社区题库的格式见 community/SCHEMA.md）');
      return;
    }
    setError(null);
    api.importCommunityFile(file);
  };

  return (
    <div className="exp__community">
      <p className="field__hint">
        社区题库是<strong>离线</strong>的：你自己去 GitHub 下载 <code>community/</code> 里的 JSON，
        再拖进来。产品本身不会为你发起任何网络请求 —— 这是隐私承诺的一部分，不是偷懒。
      </p>

      <div
        className={dragging ? 'exp__drop is-dragging' : 'exp__drop'}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          handleFile(event.dataTransfer.files?.[0]);
        }}
      >
        <span className="muted">把社区题库 .json 拖到这里</span>
        <button type="button" className="btn btn--small" onClick={() => fileRef.current?.click()}>
          选择文件
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden-file"
          onChange={(event) => {
            handleFile(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      </div>

      {error ? <div className="notice notice--danger">{error}</div> : null}

      <p className="muted">
        已导入 {communityCount} 篇社区面经（带「社区导入」角标、只读，不会被你的统计混进来当作自己的战绩）。
      </p>
    </div>
  );
}
