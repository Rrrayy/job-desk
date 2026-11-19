// @vitest-environment jsdom
/**
 * MigrationFailPage —— 只守 C7① 要的那件事。
 *
 * 库比工具新时（`lib/migrate` 对更高版本是硬拒绝：不猜着降级读，否则新字段会被悄悄丢掉），
 * 页面原来只甩一句「数据读取失败」，用户无从知道「去拿新版」。
 * 现在必须自己说清：**这份数据是 vN 写的，请用 vN 或更高版本的工具打开**，并给出 release 页。
 *
 * 三条断言对应三件事：话说清楚了 / 链接是静态超链接 / 别的原因不被冒充成「版本太新」。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationFailPage } from './MigrationFailPage';
import { MSG_BACKUP_TOO_NEW_HEAD, MSG_BACKUP_TOO_NEW_MID, SCHEMA_VERSION_CURRENT } from '../lib/migrate';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RELEASES_URL = 'https://github.com/Rrrayy/job-desk/releases';

/**
 * 与 `lib/migrate` 拼出来的 reason 逐字一致 —— 复用同一批常量，不手抄文案，
 * 这样 migrate 那边改了措辞，本测试跟着变，不会假装还绿。
 */
function tooNewReason(version: number): string {
  return `${MSG_BACKUP_TOO_NEW_HEAD}${version}${MSG_BACKUP_TOO_NEW_MID}${SCHEMA_VERSION_CURRENT}）`;
}

describe('MigrationFailPage（jsdom）', () => {
  let host: HTMLDivElement;
  let root: Root | null = null;

  const render = (reason: string): void => {
    act(() => {
      root?.render(
        <MigrationFailPage
          reason={reason}
          raw='{"schemaVersion":9}'
          backupKey={null}
          failedAtKey={null}
          onRetry={() => {}}
          onStartEmpty={() => {}}
        />,
      );
    });
  };

  /** 展平空白：JSX 的换行缩进不该影响文案断言 */
  const text = (): string => (host.textContent ?? '').replace(/\s+/g, ' ');

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    host.remove();
    root = null;
  });

  it('★ 库比工具新：一句话说清「这份数据是 v9 写的，请用 v9 或更高版本的工具打开」', () => {
    render(tooNewReason(9));
    expect(text()).toContain('这份数据是 v9 写的，请用 v9 或更高版本的工具打开');
  });

  it('★ 去拿新版的地方是个静态超链接（只有用户点它才联网，页面自身不请求任何东西）', () => {
    render(tooNewReason(9));
    const link = host.querySelector('a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe(RELEASES_URL);
    expect(link!.getAttribute('rel')).toBe('noreferrer');
    // 页面里不许出现会自动拉取资源的元素（img / iframe / link）
    expect(host.querySelectorAll('img, iframe, link')).toHaveLength(0);
  });

  it('别的失败原因：不冒充「版本太新」，也不硬塞 release 链接', () => {
    render('缺少 settings / applications 字段，这不像是本应用导出的备份');
    expect(text()).not.toContain('请用');
    expect(host.querySelector('a')).toBeNull();
  });
});
