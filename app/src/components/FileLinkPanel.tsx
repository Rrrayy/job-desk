/**
 * 文件联动面板（v0.6 / D8 的 UI 面）。
 *
 * 这个面板存在的唯一理由是**把不可见的风险变成可见的文字**：
 * 用户要能一眼看到「现在到底连没连、连的是哪个文件、能不能写、
 * 上一次写是什么时候、有没有一条没写完的」。
 *
 * 三条设计约定：
 *
 * 1. **能力不够就说实话**（Safari / Firefox / 非安全上下文）。
 *    不要给一个点了没反应的按钮 —— 那比没有这个功能更伤信任。
 * 2. **权限必须在点击里请求**。浏览器只认用户手势，所以「连接文件」
 *    是一个真按钮，不在打开面板时自动调 `requestPermission`。
 * 3. **只读时的三个出口永远可见**：下载原始文件 / 重试 / 另存为新文件。
 *    原始数据绝不自动修改或删除 —— 这行字要写在面板上，不只是写在文档里。
 */

import { useCallback, useEffect, useState } from 'react';
import type { AppApi } from '../lib/api';
import { ENCRYPTION_DISCLAIMER, assessPassword, detectCryptoCapability } from '../lib/crypto';
import type { FileLinkCapability } from '../lib/fileLink/handle';

export interface FileLinkPanelProps {
  api: AppApi;
  capability: FileLinkCapability;
  /** 已连接的文件名（null = 没连） */
  fileName: string | null;
  /** 上次写入时刻（ISO） */
  lastSyncedAt: string | undefined;
  /** 上一次冲突副本名 */
  lastConflictFile: string | undefined;
  /** 只读原因（null = 可写） */
  readOnlyMessage: string | null;
  /** 有没有一条中断的写入等着重放 */
  hasPending: boolean;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onRetryPermission: () => void;
  onDownloadRaw: () => void;
  onSaveAs: () => void;
  onReplay: () => void;
  /** 加密开关（D10）；返回错误文案或 null */
  onToggleEncryption: (enabled: boolean, password: string) => Promise<string | null>;
}

const CAPABILITY_TEXT: Record<FileLinkCapability, { title: string; detail: string }> = {
  full: {
    title: '可用',
    detail: '这个浏览器支持文件句柄，可以把工作台的数据直接落到你选的文件上。',
  },
  insecure: {
    title: '需要 https',
    detail:
      '当前通过 http 打开，浏览器不提供文件句柄能力。改用 https 地址、或者直接双击 index.html 打开，就能启用联动。',
  },
  unsupported: {
    title: '不支持',
    detail:
      '这个浏览器没有 File System Access 能力（Safari / Firefox / 移动端都如此）。降级为手动导入导出 —— 功能不受影响，只是每次要自己点一下。',
  },
};

export function FileLinkPanel(props: FileLinkPanelProps) {
  const { api, capability, fileName, lastSyncedAt, lastConflictFile, readOnlyMessage } = props;
  const settings = api.db.settings;
  const capabilityInfo = CAPABILITY_TEXT[capability];

  /* ------------------------------ 加密 ------------------------------ */
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [cryptoError, setCryptoError] = useState<string | null>(null);
  const [cryptoBusy, setCryptoBusy] = useState(false);
  const cryptoCapability = detectCryptoCapability();
  const strength = password ? assessPassword(password) : null;

  /**
   * 关闭加密时也要口令：不是为了"验证"，而是因为**已经写出去的文件是加密的**，
   * 关掉开关必须先确认你能读出它，否则下一次保存就会把加密文件覆盖成明文 ——
   * 用户以为「关掉了更简单」，实际是把一份需要口令才安全的东西变成了裸奔。
   */
  const toggleEncryption = useCallback(
    async (next: boolean): Promise<void> => {
      setCryptoError(null);
      if (next && password !== confirmPassword) {
        setCryptoError('两次输入的口令不一致');
        return;
      }
      if (!password) {
        setCryptoError('请先设置一个口令（至少 8 位）');
        return;
      }
      setCryptoBusy(true);
      try {
        const error = await props.onToggleEncryption(next, password);
        if (error) {
          setCryptoError(error);
          return;
        }
        setPassword('');
        setConfirmPassword('');
      } finally {
        setCryptoBusy(false);
      }
    },
    [password, confirmPassword, props],
  );

  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    // 只用于把 ISO 时间戳渲染成「x 分钟前」，不需要秒级精度
    const timer = window.setInterval(() => setNowTick((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="filelink">
      <div className="filelink__status">
        <span className={`filelink__dot ${fileName ? (readOnlyMessage ? 'filelink__dot--warn' : 'filelink__dot--ok') : ''}`} />
        <strong>
          {fileName
            ? readOnlyMessage
              ? '已连接（只读）'
              : '已连接'
            : capability === 'full'
              ? '未连接'
              : '当前环境不支持联动'}
        </strong>
        <span className="muted">能力：{capabilityInfo.title}</span>
      </div>

      {capability !== 'full' ? <p className="field__hint">{capabilityInfo.detail}</p> : null}

      {fileName ? (
        <p className="field__hint">
          联动文件：<code>{fileName}</code>
          {lastSyncedAt ? ` · 上次写入 ${describeAgo(lastSyncedAt, nowTick)}` : ''}
        </p>
      ) : null}

      {readOnlyMessage ? (
        <div className="notice notice--warn">
          <strong>已切换为只读</strong>
          <p>{readOnlyMessage}</p>
          <p className="field__hint">
            原始文件不会被自动修改或删除。请从下面三个出口里选一个：
          </p>
          <div className="btn-row">
            <button type="button" className="btn btn--small" onClick={props.onDownloadRaw}>
              下载原始文件
            </button>
            <button type="button" className="btn btn--small" onClick={props.onRetryPermission} disabled={props.busy}>
              重试
            </button>
            <button type="button" className="btn btn--small" onClick={props.onSaveAs} disabled={props.busy}>
              另存为新文件
            </button>
          </div>
        </div>
      ) : null}

      {props.hasPending ? (
        <div className="notice notice--tip">
          <strong>有一条中断的写入</strong>
          <p>
            上次保存时浏览器被关掉或进程被结束，这条内容还没落进文件。重放之前会先比对文件内容，
            如果文件在这期间被别处改过，就不会重放，而是存成冲突副本。
          </p>
          <div className="btn-row">
            <button type="button" className="btn btn--small" onClick={props.onReplay} disabled={props.busy}>
              现在重放
            </button>
          </div>
        </div>
      ) : null}

      {lastConflictFile ? (
        <p className="field__hint field__hint--danger">
          最近一次冲突副本：<code>{lastConflictFile}</code>
          —— 文件在两次保存之间被外部修改过，工作台没有覆盖它，把你的版本另存成了这个副本。
        </p>
      ) : null}

      <div className="btn-row">
        <button type="button" className="btn btn--small" onClick={props.onConnect} disabled={capability !== 'full' || props.busy}>
          {fileName ? '换一个文件' : '连接文件'}
        </button>
        {fileName ? (
          <button type="button" className="btn btn--small btn--ghost" onClick={props.onDisconnect} disabled={props.busy}>
            断开联动
          </button>
        ) : null}
      </div>

      <p className="field__hint">
        联动开启后，每次改动自动写进这个文件（同一时刻只写一次，连续改动只落最后一版）。
        写入前会重新读一遍文件比对内容，发现被外部改过就**不覆盖**，而是另存一个
        <code>data.conflict-日期-时刻.json</code> 让你自己决定。
        <br />
        {settings.fileLink.enabled
          ? '开启联动不等于免备份：换浏览器、清站点数据仍会丢掉句柄，重要节点还是导出一份 JSON 更稳。'
          : '文件联动是可选的。它解决的是「数据只在浏览器里，换台机器就没了」，不替代备份。'}
      </p>

      {/* ------------------------------ 加密 ------------------------------ */}
      <div className="filelink__crypto">
        <div className="filelink__status">
          <span className={`filelink__dot ${settings.encryption?.enabled ? 'filelink__dot--ok' : ''}`} />
          <strong>{settings.encryption?.enabled ? '导出已加密' : '导出未加密'}</strong>
          <span className="muted">AES-256-GCM · PBKDF2 60 万轮</span>
        </div>

        {cryptoCapability !== 'available' ? (
          <p className="field__hint field__hint--danger">
            {cryptoCapability === 'insecure'
              ? '当前通过 http 打开，浏览器不提供加密能力。改用 https 或直接双击 index.html 后才能启用。'
              : '当前浏览器没有 Web Crypto 支持，无法启用加密。'}
          </p>
        ) : (
          <>
            <div className="drawer__row">
              <label className="field field--narrow">
                <span className="field__label">口令</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="至少 8 位"
                />
              </label>
              {!settings.encryption?.enabled ? (
                <label className="field field--narrow">
                  <span className="field__label">再输一次</span>
                  <input
                    className="input"
                    type="password"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                  />
                </label>
              ) : null}
            </div>
            {strength ? (
              <p className={`field__hint ${strength.level === 'weak' ? 'field__hint--danger' : ''}`}>
                口令强度：{strength.level === 'strong' ? '强' : strength.level === 'fair' ? '中' : '弱'} · {strength.hint}
              </p>
            ) : null}
            {cryptoError ? <p className="field__hint field__hint--danger">{cryptoError}</p> : null}
            <div className="btn-row">
              {settings.encryption?.enabled ? (
                <button
                  type="button"
                  className="btn btn--small btn--ghost"
                  onClick={() => void toggleEncryption(false)}
                  disabled={cryptoBusy}
                >
                  {cryptoBusy ? '处理中…' : '关闭加密'}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => void toggleEncryption(true)}
                  disabled={cryptoBusy || !password}
                >
                  {cryptoBusy ? '派发密钥中…' : '启用加密'}
                </button>
              )}
            </div>
          </>
        )}

        <p className="field__hint field__hint--danger">{ENCRYPTION_DISCLAIMER}</p>
        <p className="field__hint">
          派生 60 万轮 PBKDF2 需要零点几秒，这是**故意**慢的。口令不会存进 localStorage、
          不会写进导出的文件、也不会出现在 URL 里。
        </p>
      </div>
    </div>
  );
}

function describeAgo(iso: string, _tick: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '时间未知';
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
