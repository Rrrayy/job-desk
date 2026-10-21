/**
 * v0.7 JD 区块：把「只是一个字符串」的 jdUrl 变成能用的东西。
 *
 * 三件事，全部零网络（<a> 跳转是浏览器行为，应用不发请求）：
 * 1. 链接可点 / 可复制 / 可标记失效（jdLinkDeadAt，可恢复 ≠ 删除）；
 * 2. 粘贴 JD 正文 → parseJdText 解析 → 待确认区，逐字段「采用」才落库，
 *    默认不写任何字段 —— 解析结果进字段必须过用户的手；
 * 3. JD 原文留档（jdText + jdCapturedAt），只在用户勾选后写入。
 *
 * 诚实降级：六项识别状态永远全显示，未识别给原因，不猜；
 * 公司名只展示不建议写入 —— 公司名挂在 Company 上，改名影响所有关联投递。
 */

import { useState } from 'react';
import { JD_TEXT_MAX_CHARS, parseJdText, type JdDigest } from '../adapters/shared';
import { copyText, cx, safeHref } from '../lib/util';
import type { AppApi } from '../lib/api';
import type { Application } from '../types';
import { Field } from './Field';

/** 哪些解析字段允许「采用」写入（companyName 只展示不写，见文件头注释） */
const ADOPTABLE_FIELDS = ['jobTitle', 'city', 'salaryText'] as const;
type AdoptableField = (typeof ADOPTABLE_FIELDS)[number];

const FIELD_LABEL: Record<AdoptableField, string> = {
  jobTitle: '岗位',
  city: '城市',
  salaryText: '薪资',
};

export function JdPanel({ api, app }: { api: AppApi; app: Application }) {
  const { now } = api;
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [digest, setDigest] = useState<JdDigest | null>(null);
  const [adopted, setAdopted] = useState<Partial<Record<AdoptableField, boolean>>>({});
  const [saveBody, setSaveBody] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const href = safeHref(app.jdUrl);
  const dead = Boolean(app.jdLinkDeadAt);
  const update = (patch: Partial<Application>): void => api.updateApplication(app.id, patch);

  const runParse = (): void => {
    setError(null);
    setAdopted({});
    if (!pasteText.trim()) {
      setDigest(null);
      return;
    }
    if (pasteText.length > JD_TEXT_MAX_CHARS) {
      setError(`JD 原文上限 ${JD_TEXT_MAX_CHARS} 字符，这段是 ${pasteText.length} 字符 —— 不做静默截断，请删减后再试`);
      setDigest(null);
      return;
    }
    setDigest(parseJdText(pasteText, now.toISOString()));
  };

  const applyAdopted = (): void => {
    if (!digest) return;
    setError(null);
    const patch: Partial<Application> = {};
    for (const field of ADOPTABLE_FIELDS) {
      if (!adopted[field]) continue;
      const value = digest.record?.[field];
      if (typeof value === 'string' && value) patch[field] = value;
    }
    if (saveBody && pasteText.trim()) {
      patch.jdText = pasteText;
      patch.jdCapturedAt = now.toISOString();
    }
    if (Object.keys(patch).length === 0) return;
    update(patch);
    setDigest(null);
    setPasteText('');
    setPasteOpen(false);
    setAdopted({});
  };

  const toggleAdopt = (field: AdoptableField): void =>
    setAdopted((prev) => ({ ...prev, [field]: !prev[field] }));

  const copyLink = async (): Promise<void> => {
    if (!app.jdUrl) return;
    if (await copyText(app.jdUrl)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  // 六项识别状态（M4）：永远全出现，不因失败隐藏整块
  const sectionOf = (kind: string) => digest?.sections.find((section) => section.kind === kind);
  const rec = digest?.record ?? null;
  const statusRows: Array<{ label: string; state: 'ok' | 'none'; value: string }> = [
    {
      label: '公司名',
      state: rec?.companyName ? 'ok' : 'none',
      value: rec?.companyName || '没找到公司名行（可能是登录墙后的半页）',
    },
    { label: '岗位', state: rec?.jobTitle ? 'ok' : 'none', value: rec?.jobTitle || '没认出岗位名' },
    { label: '城市', state: rec?.city ? 'ok' : 'none', value: rec?.city || '没认出城市' },
    { label: '薪资', state: rec?.salaryText ? 'ok' : 'none', value: rec?.salaryText || '没认出薪资' },
    {
      label: '岗位职责段',
      state: sectionOf('duty') ? 'ok' : 'none',
      value: sectionOf('duty') ? `${sectionOf('duty')!.lines.length} 行` : '没找到「岗位职责」类标题行',
    },
    {
      label: '任职要求段',
      state: sectionOf('require') ? 'ok' : 'none',
      value: sectionOf('require') ? `${sectionOf('require')!.lines.length} 行` : '没找到「任职要求」类标题行',
    },
  ];

  return (
    <div className="jd-panel" data-testid="jd-panel">
      <Field
        label="JD 链接"
        type="url"
        value={app.jdUrl || ''}
        onCommit={(value) => update({ jdUrl: value.trim() || undefined, jdLinkDeadAt: undefined })}
        placeholder="https://"
        hint="J 键可快速打开（详情页打开时）"
      />

      <div className="jd-panel__actions">
        {href && !dead && (
          <a className="btn" href={href} target="_blank" rel="noopener noreferrer" title={app.jdUrl}>
            ↗ 打开 JD
          </a>
        )}
        {href && dead && <span className="jd-panel__dead">链接已标记失效</span>}
        {app.jdUrl && !href && <span className="jd-panel__dead">链接格式不对，不会跳转</span>}
        {app.jdUrl && (
          <button type="button" className="btn" onClick={copyLink}>
            {copied ? '已复制' : '复制链接'}
          </button>
        )}
        {app.jdUrl && !dead && (
          <button
            type="button"
            className="btn"
            onClick={() => update({ jdLinkDeadAt: now.toISOString() })}
            title="职位下架 / 链接打不开时标记，避免反复点；不删除链接本身"
          >
            标记失效
          </button>
        )}
        {app.jdUrl && dead && (
          <button type="button" className="btn" onClick={() => update({ jdLinkDeadAt: undefined })}>
            恢复链接
          </button>
        )}
        {!pasteOpen && (
          <button type="button" className="btn" onClick={() => setPasteOpen(true)}>
            ＋ 粘贴 JD 文本
          </button>
        )}
      </div>

      {app.jdText && (
        <details className="jd-panel__body">
          <summary>
            JD 原文留档（{app.jdText.length} 字符
            {app.jdCapturedAt ? ` · 留档于 ${app.jdCapturedAt.slice(0, 10)}` : ''}）
          </summary>
          <pre className="jd-panel__pre">{app.jdText}</pre>
        </details>
      )}

      {pasteOpen && (
        <div className="jd-panel__paste">
          <textarea
            className="jd-panel__textarea"
            rows={6}
            value={pasteText}
            onChange={(event) => setPasteText(event.target.value)}
            placeholder="在招聘页 Ctrl+A 全选复制，整页粘进来"
          />
          <div className="jd-panel__actions">
            <button type="button" className="btn btn--primary" onClick={runParse} disabled={!pasteText.trim()}>
              解析
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setPasteText('');
                setDigest(null);
                setError(null);
                setAdopted({});
              }}
            >
              清空
            </button>
          </div>

          {error && <p className="jd-panel__error">{error}</p>}

          {digest && (
            <div className="jd-panel__digest">
              <p className="jd-panel__digest-head">识别结果 —— 默认不写入，勾选后点「应用」才落库：</p>
              <ul className="jd-panel__status">
                {statusRows.map((row) => (
                  <li key={row.label}>
                    <span className={cx('jd-panel__state', row.state === 'ok' && 'is-ok')}>
                      {row.state === 'ok' ? '✅ 识别' : '— 未识别'}
                    </span>
                    <strong>{row.label}</strong>
                    <span>{row.value}</span>
                  </li>
                ))}
              </ul>

              {digest.hints.daysPerWeek && (
                <p className="jd-panel__hint">线索：每周 {digest.hints.daysPerWeek} 天（供参考，不自动写入）</p>
              )}
              {digest.hints.durationMonths && (
                <p className="jd-panel__hint">线索：实习 {digest.hints.durationMonths} 个月（供参考，不自动写入）</p>
              )}
              {digest.record?.companyName && (
                <p className="jd-panel__hint">
                  识别到公司「{digest.record.companyName}」—— 公司名不自动写入：改名会影响这家公司的全部投递，请到公司页手改。
                </p>
              )}

              <div className="jd-panel__adopt">
                {ADOPTABLE_FIELDS.map((field) => {
                  const value = digest.record?.[field];
                  const current = app[field];
                  if (typeof value !== 'string' || !value) return null;
                  return (
                    <label key={field} className="jd-panel__adopt-row">
                      <input type="checkbox" checked={Boolean(adopted[field])} onChange={() => toggleAdopt(field)} />
                      <span>
                        写入{FIELD_LABEL[field]}：
                        {current && current !== value ? (
                          <>
                            当前「{current}」→ 解析「{value}」
                          </>
                        ) : (
                          <>「{value}」{current ? '（与当前一致）' : '（当前为空）'}</>
                        )}
                      </span>
                    </label>
                  );
                })}
                <label className="jd-panel__adopt-row">
                  <input type="checkbox" checked={saveBody} onChange={() => setSaveBody(!saveBody)} />
                  <span>保存 JD 原文（{pasteText.length} 字符，含留档时间）</span>
                </label>
              </div>

              <div className="jd-panel__actions">
                <button type="button" className="btn btn--primary" onClick={applyAdopted}>
                  应用勾选项
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setDigest(null);
                    setAdopted({});
                  }}
                >
                  全部忽略
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
