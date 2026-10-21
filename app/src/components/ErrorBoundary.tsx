/**
 * 渲染崩溃兜底。
 *
 * 为什么必须有：单文件应用一旦某个视图抛异常，React 18 会卸载整棵树 ——
 * 用户看到的是纯白页面，而数据还在 localStorage 里，却没有任何出口。
 * 这里提供三个出口：重载、下载原始数据、复制错误信息（供反馈）。
 *
 * 注意：这里**不写任何 key**，也不尝试自动修复数据 —— 崩在渲染层时，
 * 任何"顺手清一下"都可能把用户仅存的一份数据覆盖掉。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { downloadRawJSON } from '../lib/storage';

const STORAGE_KEY = 'jobdesk.v1';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 控制台留一份完整堆栈，便于用户截图反馈；不上报、不联网
    console.error('[求职工作台] 渲染崩溃：', error, info.componentStack);
  }

  private readRaw(): string | null {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }

  private handleDownload = (): void => {
    const raw = this.readRaw();
    if (!raw) {
      window.alert('读不到本地数据（可能被浏览器禁止访问存储）。请不要关闭此页面，先截图反馈。');
      return;
    }
    const ok = downloadRawJSON(raw, `求职工作台-崩溃现场-${new Date().toISOString().slice(0, 10)}.json`);
    if (!ok) window.alert('下载被浏览器拦截了。请允许下载后重试，或在开发者工具里手动复制 localStorage。');
  };

  private handleCopy = (): void => {
    const error = this.state.error;
    const text = [
      `版本：${__APP_VERSION__}`,
      `时间：${new Date().toISOString()}`,
      `UA：${navigator.userAgent}`,
      `错误：${error ? `${error.name}: ${error.message}` : '未知'}`,
      error && error.stack ? `\n${error.stack}` : '',
    ].join('\n');
    void navigator.clipboard?.writeText(text).then(
      () => window.alert('错误信息已复制，可以粘贴到 issue 里。'),
      () => window.alert('复制失败。请手动截图这个页面。'),
    );
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash">
        <div className="crash__card">
          <div className="crash__badge">界面出错了</div>
          <h1 className="crash__title">你的数据还在，别慌</h1>
          <p className="crash__text">
            这次是一个<strong>渲染错误</strong>，不是数据损坏。数据仍然在浏览器本地存储里，
            刷新通常就能恢复。如果反复崩溃，先把原始数据下载下来，再反馈给作者。
          </p>
          <pre className="crash__stack">{error.name}: {error.message}</pre>
          <div className="crash__actions">
            <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
              重新加载
            </button>
            <button type="button" className="btn" onClick={this.handleDownload}>
              下载原始数据
            </button>
            <button type="button" className="btn" onClick={this.handleCopy}>
              复制错误信息
            </button>
          </div>
          <p className="crash__foot">
            v{__APP_VERSION__} · 下载的文件是标准 JSON，修复后可直接导入回来。
          </p>
        </div>
      </div>
    );
  }
}
