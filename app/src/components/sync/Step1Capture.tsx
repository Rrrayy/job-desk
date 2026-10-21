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

const PLATFORMS: PlatformId[] = ['boss', 'shixiseng', 'nowcoder', 'liepin', 'custom'];

/**
 * v0.7.2 解析模板：告诉用户「复制成什么长样的文本」才能被解析。
 * 样本为明显虚构的示例文本（行结构与真机 fixture 完全一致，不含任何真实姓名或公司），
 * 并明说各平台目前哪条路最稳。
 * 认不出的行不会丢——会进待归类，这一点也要说，免得用户以为粘贴失败。
 */
const PASTE_TEMPLATES: Partial<Record<PlatformId, { title: string; samples: { label: string; body: string }[]; note?: string }>> = {
  boss: {
    title: 'BOSS 直聘的两种可用形态',
    samples: [
      {
        label: '求职记录卡片（App 里单张卡片复制）',
        body: `王芳招聘者
杭州星澜智慧云图智能科技
半导体/芯片0-20人
Agent 研发实习生
[
杭州·滨江区·示例路
]
300-310元/天 在校/应届 本科`,
      },
      {
        label: '求职记录列表页（整页 Ctrl+A）',
        body: `10月21日
14:12
AI开发工程师实习生
苏州 高新园区 湖东 5天/周 6个月 本科
云图软创 A轮 500-999人`,
      },
    ],
    note: '卡片头「XX招聘者」会被自动丢弃；「沟通过」页签里没有状态行 → 状态留空、需要你归类，这是诚实的降级不是失败。',
  },
  shixiseng: {
    title: '实习僧：详情页整页复制目前最稳',
    samples: [
      {
        label: '职位详情页',
        body: `职位详情
前端开发实习生
150-200元/天
杭州·西湖区
岗位职责
1. 参与业务前端开发；
任职要求
1. 本科在读；
公司信息
杭州某科技有限公司`,
      },
    ],
    note: '「我的投递」列表页在真实投递数据下还没校准过——复制过来认不出的部分会进待归类，不会丢。',
  },
  nowcoder: {
    title: '牛客：详情页整页复制目前最稳',
    samples: [
      {
        label: '职位详情页',
        body: `职位详情
后端开发工程师
25-35K
北京·海淀区
岗位职责
…
任职要求
…
公司信息
某互联网公司`,
      },
    ],
    note: '「我的投递」列表页待真实数据校准，同上。',
  },
  liepin: {
    title: '猎聘：详情页 + 投递列表都可用',
    samples: [
      {
        label: '投递列表页（单条记录）',
        body: `前端开发工程师 20-35K
杭州某网络科技公司
杭州-滨江区
张女士
10月20日 16:30
已查看`,
      },
      {
        label: '职位详情页',
        body: `职位详情
前端开发工程师 20-35K
…
公司信息
杭州某网络科技公司`,
      },
    ],
  },
  custom: {
    title: '通用：有「公司名 + 岗位」的文本都能试',
    samples: [
      {
        label: '任意页面的列表',
        body: `每个记录块里至少要有一行像公司名
（以 公司/科技/集团/信息/技术 等收尾），
加一行岗位名（实习/工程师/开发…）。
有空行分隔的块最稳。`,
      },
    ],
    note: '没有公司名的块会进待归类并说明原因，不会静默丢弃。',
  },
};

export function Step1Capture(props: Step1CaptureProps) {
  const { text, onText, platform, onPlatform, onParse, parsing, error, summary } = props;
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const template = PASTE_TEMPLATES[platform];

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
        把页面<strong>整页复制</strong>过来（Ctrl+A → Ctrl+C → 这里 Ctrl+V），
        或把扩展抓下来的内容直接粘贴进来，也可以拖入一个 <code>.json</code> / <code>.txt</code> 文件。
      </p>

      {template ? (
        <details className="sync__template">
          <summary>复制样板 —— 复制成这样的文本才能解析（{template.title}）</summary>
          {template.samples.map((sample) => (
            <div key={sample.label} className="sync__template-sample">
              <span className="sync__template-label">{sample.label}</span>
              <pre>{sample.body}</pre>
            </div>
          ))}
          {template.note ? <p className="muted sync__template-note">{template.note}</p> : null}
        </details>
      ) : null}

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
