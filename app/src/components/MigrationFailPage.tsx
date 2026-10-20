/**
 * 迁移失败页（PRD §D.3 三出口）。
 *
 * 出现在 App 启动时 `loadDB()` 返回 `migration.failed` 的情况下。
 *
 * ★ QA D4 之后，这个组件说话必须是真的：
 * 之前这里写着「绝不写任何 storage key」「你的原始数据没有被修改」，而实际上 App 的
 * 落盘 effect 已经把 `jobdesk.v1` 覆盖成空骨架 —— 两句文案都是假话。
 * 现在写盘闸门在 `lib/storage.ts`，进失败页即上锁；并且读失败时原文会另存到
 * `jobdesk.v1.failedAt.<ISO>`，本页把这个 key 明确显示出来让用户能复制。
 */

import { useState } from 'react';
import { downloadRawJSON } from '../lib/storage';

export interface MigrationFailPageProps {
  reason: string;
  raw: string;
  backupKey: string | null;
  /** 读失败时另存的原文 key（QA D4）。为 null 表示没能另存（配额满 / 隐私模式） */
  failedAtKey: string | null;
  /** 重试：重新读一次 localStorage（用户可能在别处修好了） */
  onRetry: () => void;
  /** 空数据继续：明确告知「原数据还有一份副本」，只是这次不加载 */
  onStartEmpty: () => void;
}

export function MigrationFailPage(props: MigrationFailPageProps) {
  const { reason, raw, backupKey, failedAtKey, onRetry, onStartEmpty } = props;
  const [downloaded, setDownloaded] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyKey = (): void => {
    if (!failedAtKey) return;
    try {
      void navigator.clipboard.writeText(`localStorage.getItem('${failedAtKey}')`);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="app">
      <main className="main">
        <div className="banner banner--error">
          <strong>数据读取失败，已暂停加载</strong>
          <p>{reason}</p>
          <p className="muted">
            我们<strong>没有删除</strong>你的数据，也<strong>不会</strong>在你看这一页的时候写回任何内容
            —— 这个页面上所有按钮都不会覆盖 <code>jobdesk.v1</code>。
          </p>
        </div>

        <section className="card">
          <h2 className="card__title">原始数据已经另存了一份</h2>
          {failedAtKey ? (
            <>
              <p className="muted">
                读失败的那一刻，原始文本被原样复制到了一个新的 key（内容和 <code>jobdesk.v1</code>{' '}
                完全一样）：
              </p>
              <p>
                <code>{failedAtKey}</code>{' '}
                <button type="button" className="link-btn" onClick={copyKey}>
                  {copied ? '已复制' : '复制取回命令'}
                </button>
              </p>
              <p className="muted">
                取回方法：开发者工具 → Console，粘贴{' '}
                <code>{`copy(localStorage.getItem('${failedAtKey}'))`}</code>
                ，再粘到编辑器里存成 .json。最多保留 3 份（同样的内容不会重复存）。
              </p>
            </>
          ) : (
            <p className="muted">
              这份原文<strong>没能另存</strong>（多半是浏览器存储配额已满，或处于隐私模式）。
              请立刻用下面的「下载原始 JSON」把它存到磁盘 —— 这一份只在内存里。
            </p>
          )}
        </section>

        <section className="card">
          <h2 className="card__title">① 先下载原始数据（最稳的一步）</h2>
          <p className="muted">
            下载下来的是一份完整的 JSON 文本，改坏了也能用编辑器修。修好之后放回 localStorage 的{' '}
            <code>jobdesk.v1</code>，再点「重试」。
          </p>
          <div className="drawer__actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                const ok = downloadRawJSON(raw, `求职工作台-原始数据-${new Date().toISOString().slice(0, 10)}.json`);
                setDownloaded(ok);
              }}
            >
              下载原始 JSON（{Math.round(raw.length / 1024)} KB）
            </button>
            {downloaded ? <span className="muted">已触发下载，检查一下浏览器的下载列表。</span> : null}
          </div>
        </section>

        <section className="card">
          <h2 className="card__title">② 重试</h2>
          <p className="muted">
            如果你刚把数据修好、或者换了浏览器配置，点一下重新读取。这条不会覆盖任何东西，只是再读一次。
          </p>
          <div className="drawer__actions">
            <button type="button" className="btn" onClick={onRetry}>
              重新读取
            </button>
          </div>
        </section>

        <section className="card">
          <h2 className="card__title">③ 用空数据继续</h2>
          <p className="muted">
            进去之后可以先看看界面。注意：从这一刻起<strong>才会开始正常保存</strong> ——
            新记的内容会写进 <code>jobdesk.v1</code>，那份坏掉的旧数据只剩上面那个{' '}
            {failedAtKey ? <code>{failedAtKey}</code> : '下载文件'} 里的副本。
            所以请先把原始数据备份好再点。
          </p>
          <div className="drawer__actions">
            <button type="button" className="btn" onClick={onStartEmpty}>
              用空数据进入
            </button>
          </div>
        </section>

        {backupKey ? (
          <p className="muted">
            迁移前的回滚点仍在：<code>{backupKey}</code>（30 天后自动清理）。需要时可以在开发者工具的
            Application → Local Storage 里取回。
          </p>
        ) : null}
      </main>
    </div>
  );
}
