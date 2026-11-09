// @vitest-environment jsdom
/**
 * `SettingsDrawer` 的**交互层**测试（v0.9.2 · 清掉 v0.9.1 发布说明 §4.3 点名的最大一块测试债）。
 *
 * ## 为什么与 `SettingsDrawer.test.tsx` 并存而不是合并
 *
 * 那一份是「薄挂载」：只证明简历回收站子区**被挂上了**（组件对了但没接线是另一类 bug）。
 * 这一份是「交互」：证明设置页里的按钮/输入真的接到了 `api` 的正确方法上。
 * 两类断言的目的不同、失效方式也不同，放在同一文件里会让人分不清红灯意味着什么。
 *
 * ## 边界
 *
 * 只断言**设置页自己拥有的接线**（onBlur / onClick / onChange → api.X）。
 * 不重复断言子组件内部行为（`PluginsPanel` / `AiSettingsPanel` / `FileLinkPanel`
 * 各自的测试在它们自己的文件里）。这里对子区只给「挂载期真正会读到的成员」，
 * 漏给就当场炸 —— 桩本身就是护栏。
 *
 * ## 为什么每个操作都要断言「调用参数」而不只是「被调过」
 *
 * 「点了按钮 → api 被调用」证明不了接线正确：把 `extendTrash(id)` 写成 `restoreApplication(id)`
 * 同样会「被调过」。所以关键路径一律断言 **方法名 + 实参**，永久删除还额外断言
 * **第一次点击不许调用**（两步确认不能被跳过）。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppApi } from '../lib/api';
import type { Application, DB } from '../types';
import { emptyDB } from '../lib/defaults';
import { SettingsDrawer } from './SettingsDrawer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ = '0.9.2';

function makeTrashedApp(overrides: Partial<Application> = {}): Application {
  return {
    id: 'app-trash-1',
    companyId: 'c-1',
    jobTitle: '前端实习',
    status: 'chatting',
    statusChangedAt: '2026-10-19T01:00:00.000Z',
    lastActivityAt: '2026-10-19T01:00:00.000Z',
    createdAt: '2026-10-19T01:00:00.000Z',
    updatedAt: '2026-10-19T01:00:00.000Z',
    deletedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

/** 只给设置页与五个子区在**交互路径**上真正读到的成员（漏给 = 当场炸） */
function makeApi(overrides: Partial<Record<string, unknown>> = {}): AppApi {
  const db: DB = emptyDB();
  const api = {
    db,
    now: new Date('2026-11-10T00:00:00.000Z'),
    storageBackend: () => 'localStorage',
    checkStorage: () => Promise.resolve({ usage: 2 * 1024 * 1024, quota: 5 * 1024 * 1024, ratio: 0.4 }),
    updateSettings: vi.fn(),
    setView: vi.fn(),
    toast: vi.fn(),
    exportData: vi.fn(),
    exportCsv: vi.fn(),
    exportIcs: vi.fn(),
    exportPortable: vi.fn(() => Promise.resolve()),
    importData: vi.fn(),
    importCommunityFile: vi.fn(),
    clearAllData: vi.fn(),
    loadSampleData: vi.fn(),
    openSync: vi.fn(),
    emptyTrash: vi.fn(),
    restoreApplication: vi.fn(),
    extendTrash: vi.fn(),
    purgeApplication: vi.fn(),
    ai: { ready: false, readyReason: '未配置', clearRequestLog: vi.fn() },
    fileLink: {
      capability: 'unsupported' as const,
      fileName: null,
      readOnlyMessage: null,
      hasPending: false,
      busy: false,
      connect: vi.fn(),
      disconnect: vi.fn(),
      retryPermission: vi.fn(),
      downloadRaw: vi.fn(),
      saveAs: vi.fn(),
      replayPending: vi.fn(),
      toggleEncryption: vi.fn(),
    },
    plugins: {
      list: () => [],
      setEnabled: vi.fn(),
      setPermission: vi.fn(),
      uninstall: vi.fn(),
      loadPackageFile: vi.fn(),
    },
    resume: {
      trashed: [],
      trashedVersionsOf: () => [],
      restore: vi.fn(),
      purge: vi.fn(),
      extendTrash: vi.fn(),
    },
    ...overrides,
  } as unknown as AppApi;
  return api;
}

/** React 受控 input/select 的原生写入（直接赋值不会触发 onChange） */
function setNativeValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** 失焦写回走 React 的 `onBlur`（React 17+ 监听 focusout） */
function blur(el: HTMLElement): void {
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
}

/** 按可见文案找按钮（`exact` 默认 false：文案里常带数量后缀） */
function buttonByText(container: HTMLElement, text: string, exact = false): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll('button')].find((button) =>
      exact ? button.textContent?.trim() === text : button.textContent?.includes(text),
    ) ?? null
  );
}

/** 按 label 文案找它的输入控件（设置页里同形控件多，不能按下标猜） */
function controlByLabel(
  container: HTMLElement,
  labelText: string,
): HTMLInputElement | HTMLSelectElement | null {
  const label = [...container.querySelectorAll('label')].find((el) =>
    el.textContent?.includes(labelText),
  );
  return (label?.querySelector('input, select') as HTMLInputElement | HTMLSelectElement) ?? null;
}

describe('SettingsDrawer 交互（jsdom）', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.clear();
  });

  async function render(
    api: AppApi,
    props: { importError?: string | null; trashed?: Application[]; onClose?: () => void; onDismissError?: () => void } = {},
  ): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <SettingsDrawer
          api={api}
          onClose={props.onClose ?? (() => {})}
          importError={props.importError ?? null}
          onDismissError={props.onDismissError ?? (() => {})}
          trashed={props.trashed ?? []}
        />,
      );
    });
  }

  /* ------------------------------------------------------------ 阈值与设置 */

  it('★ 修改沉默阈值后失焦：写回的是带 key 的 patch（{warnAfterDays: 5}，不是整份 settings）', async () => {
    const api = makeApi();
    await render(api);

    const input = controlByLabel(container, '该跟进（黄）') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      setNativeValue(input, '5');
      blur(input);
    });

    expect(api.updateSettings).toHaveBeenCalledTimes(1);
    expect(api.updateSettings).toHaveBeenCalledWith({ warnAfterDays: 5 });
  });

  it('非法阈值（0 / 负数 / 空）不写回：不许把出厂值意外改成 0', async () => {
    const api = makeApi();
    await render(api);

    const input = controlByLabel(container, '已沉默（红）') as HTMLInputElement;
    for (const bad of ['0', '-3', '']) {
      await act(async () => {
        setNativeValue(input, bad);
        blur(input);
      });
    }

    expect(api.updateSettings).not.toHaveBeenCalled();
  });

  it('默认简历版本失焦写回，且去掉首尾空格', async () => {
    const api = makeApi();
    await render(api);

    const input = container.querySelector('input[placeholder="v3-前端-项目版"]') as HTMLInputElement;
    await act(async () => {
      setNativeValue(input, '  v3-前端-项目版  ');
      blur(input);
    });

    expect(api.updateSettings).toHaveBeenCalledWith({ defaultResumeVersion: 'v3-前端-项目版' });
  });

  it('备份提醒下拉：选「不提醒」写回 0（0 是合法值，不是被忽略）', async () => {
    const api = makeApi();
    await render(api);

    const select = controlByLabel(container, '备份提醒') as HTMLSelectElement;
    await act(async () => {
      setNativeValue(select, '0');
    });

    expect(api.updateSettings).toHaveBeenCalledWith({ backupReminderDays: 0 });
  });

  /* ------------------------------------------------------------ 数据导入导出 */

  it('★ 四个导出按钮各接各的方法（JSON / CSV / ICS / 便携包不许串线）', async () => {
    const api = makeApi();
    await render(api);

    await act(async () => {
      buttonByText(container, '导出 JSON', true)?.click();
      buttonByText(container, '导出 CSV', true)?.click();
      buttonByText(container, '导出日历', true)?.click();
      buttonByText(container, '导出便携包', true)?.click();
    });

    expect(api.exportData).toHaveBeenCalledTimes(1);
    expect(api.exportCsv).toHaveBeenCalledTimes(1);
    expect(api.exportIcs).toHaveBeenCalledTimes(1);
    expect(api.exportPortable).toHaveBeenCalledTimes(1);
  });

  it('选择文件后把 File 交给 importData，并把 input 复位（同一文件连选两次都要能触发）', async () => {
    const api = makeApi();
    await render(api);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['{"applications":[]}'], 'backup.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });

    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(api.importData).toHaveBeenCalledWith(file);
    expect(input.value).toBe('');
  });

  it('导入失败横幅：显示具体原因，「知道了」接到 onDismissError', async () => {
    const api = makeApi();
    const onDismissError = vi.fn();
    await render(api, { importError: '第 3 行缺少 companyId', onDismissError });

    expect(container.textContent).toContain('导入失败');
    expect(container.textContent).toContain('第 3 行缺少 companyId');

    await act(async () => {
      buttonByText(container, '知道了', true)?.click();
    });
    expect(onDismissError).toHaveBeenCalledTimes(1);
  });

  it('★ 回到初始状态是两步：第一次点击只出确认文案、不调用 clearAllData', async () => {
    const api = makeApi();
    await render(api);

    await act(async () => {
      buttonByText(container, '回到初始状态', true)?.click();
    });
    expect(api.clearAllData).not.toHaveBeenCalled();
    expect(container.textContent).toContain('这一步不可撤销');

    await act(async () => {
      buttonByText(container, '确认回到初始状态', true)?.click();
    });
    expect(api.clearAllData).toHaveBeenCalledTimes(1);
  });

  it('清空确认可以取消：取消后不调用 clearAllData，且按钮回到第一步', async () => {
    const api = makeApi();
    await render(api);

    await act(async () => {
      buttonByText(container, '回到初始状态', true)?.click();
    });
    await act(async () => {
      buttonByText(container, '取消', true)?.click();
    });

    expect(api.clearAllData).not.toHaveBeenCalled();
    expect(buttonByText(container, '回到初始状态', true)).not.toBeNull();
  });

  it('加载示例数据同样是两步确认，确认后才调 loadSampleData', async () => {
    const api = makeApi();
    await render(api);

    await act(async () => {
      buttonByText(container, '加载示例数据', true)?.click();
    });
    expect(api.loadSampleData).not.toHaveBeenCalled();

    await act(async () => {
      buttonByText(container, '确定加载', true)?.click();
    });
    expect(api.loadSampleData).toHaveBeenCalledTimes(1);
  });

  /* ------------------------------------------------------------ 投递回收站 */

  it('★ 清空回收站：两步确认 + 文案带真实条数', async () => {
    const api = makeApi();
    await render(api, { trashed: [makeTrashedApp()] });

    await act(async () => {
      buttonByText(container, '清空回收站', true)?.click();
    });
    expect(api.emptyTrash).not.toHaveBeenCalled();

    await act(async () => {
      buttonByText(container, '确认清空 1 条', true)?.click();
    });
    expect(api.emptyTrash).toHaveBeenCalledTimes(1);
  });

  it('单条操作各接各的方法：恢复 / 再留 7 天 带的是这条的 id', async () => {
    const api = makeApi();
    const app = makeTrashedApp({ id: 'app-trash-42' });
    await render(api, { trashed: [app] });

    await act(async () => {
      buttonByText(container, '恢复', true)?.click();
      buttonByText(container, '再留 7 天', true)?.click();
    });

    expect(api.restoreApplication).toHaveBeenCalledWith('app-trash-42');
    expect(api.extendTrash).toHaveBeenCalledWith('app-trash-42');
  });

  it('★ 永久删除两步：第一次点击只进入确认态，确认后才 purge 且带 id', async () => {
    const api = makeApi();
    const app = makeTrashedApp({ id: 'app-trash-7' });
    await render(api, { trashed: [app] });

    await act(async () => {
      buttonByText(container, '永久删除', true)?.click();
    });
    expect(api.purgeApplication).not.toHaveBeenCalled();

    await act(async () => {
      buttonByText(container, '确认永久删除', true)?.click();
    });
    expect(api.purgeApplication).toHaveBeenCalledWith('app-trash-7');
  });

  /* ------------------------------------------------------------ 平台同步 */

  it('默认平台变更：写回的是 sync 的完整对象（不是只发一个字段，避免被覆盖成 undefined）', async () => {
    const api = makeApi();
    await render(api);

    const select = controlByLabel(container, '默认平台') as HTMLSelectElement;
    await act(async () => {
      setNativeValue(select, 'nowcoder');
    });

    const patch = (api.updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      sync: { defaultPlatform: string };
    };
    expect(patch.sync.defaultPlatform).toBe('nowcoder');
    expect(typeof patch.sync).toBe('object');
  });

  it('平台时间刷新关掉时写回布尔 false（不是字符串 "off"）', async () => {
    const api = makeApi();
    await render(api);

    const select = controlByLabel(container, '平台时间刷新') as HTMLSelectElement;
    await act(async () => {
      setNativeValue(select, 'off');
    });

    const patch = (api.updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      sync: { autoRefreshActivity: boolean };
    };
    expect(patch.sync.autoRefreshActivity).toBe(false);
  });

  it('重置风险确认：仅在有 riskAckAt 时出现，点击后写回 undefined 并给 toast', async () => {
    const api = makeApi();
    api.db.settings.sync.riskAckAt = '2026-03-01T10:00:00.000Z';
    await render(api);

    await act(async () => {
      buttonByText(container, '重置风险确认', true)?.click();
    });

    const patch = (api.updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      sync: { riskAckAt?: string };
    };
    expect(patch.sync.riskAckAt).toBeUndefined();
    expect(api.toast).toHaveBeenCalledTimes(1);
  });

  /* ------------------------------------------------------------ 框架行为 */

  it('★ 点击遮罩关闭；点击抽屉内部不关闭（stopPropagation 真的在）', async () => {
    const api = makeApi();
    const onClose = vi.fn();
    await render(api, { onClose });

    const drawer = container.querySelector('.drawer--settings') as HTMLElement;
    await act(async () => {
      drawer.click();
    });
    expect(onClose).not.toHaveBeenCalled();

    const overlay = container.firstElementChild as HTMLElement;
    await act(async () => {
      overlay.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('「去日历导入课表」切到日历并关闭设置（两个动作都要发生）', async () => {
    const api = makeApi();
    const onClose = vi.fn();
    await render(api, { onClose });

    await act(async () => {
      buttonByText(container, '去日历导入课表', false)?.click();
    });

    expect(api.setView).toHaveBeenCalledWith('calendar');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('存储用量渲染的是 checkStorage 的真实比例（40%）', async () => {
    const api = makeApi();
    await render(api);

    expect(container.textContent).toContain('40%');
    expect(container.textContent).toContain('已用');
  });
});
