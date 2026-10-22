// @vitest-environment jsdom
/**
 * AiScenarioPanel 组件测试（v0.8 / T05）。
 *
 * 盯的是「不给用户惊喜」这条线：
 * ① 未配置时按钮置灰 + 内联原因，点了也不会发请求；
 * ② 预览弹层的默认勾选就是实际发送内容（D14 只发粘贴原文）；
 * ③ 失败只在面板里显示一行人话，不弹错误框；
 * ④ 建议必须逐条勾选，接受走 api.ai.acceptSuggestions（单次 mutate + ⌘Z）。
 *
 * 网络全程 mock：本项目的测试从不真实联网（check-no-network 只放行 gateway.ts 一处）。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiScenarioPanel } from './AiScenarioPanel';
import type { AppApi } from '../../lib/api';
import type { AiResumeModule, AiRunInput, AiRunOutcome } from '../../ai/types';
import { createSuggestions } from '../../ai/suggestions';
import { emptyDB } from '../../lib/defaults';
import type { DB } from '../../types';

const NOW = '2026-10-21T10:00:00.000Z';
const RAW = '字节跳动 前端开发实习生 25k 北京 已投递';

interface Harness {
  api: AppApi;
  db: DB;
  accepts: string[][];
  runs: AiRunInput[];
}

function makeApi(options: { ready?: boolean; reason?: string; run?: (input: AiRunInput) => Promise<AiRunOutcome> } = {}): Harness {
  const db = emptyDB();
  db.settings.ai = { baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', isLocal: true };
  /*
   * 面板是「自给自足」的：场景数据一律从 db 读（T05 合并三个包装组件后不再收 props），
   * 所以测试必须先把 D14 的面经、D17 的暂存行造出来，否则锁定原文自然取到空串。
   */
  db.experiences = [
    {
      id: 'exp-1',
      companyName: '字节跳动',
      jobTitle: '前端实习生',
      interviewDate: '2026-10-01',
      result: 'pending',
      source: 'self',
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
  db.staging = [
    {
      id: 'st-1',
      platform: 'custom',
      reason: 'unparsed',
      parsed: { companyName: '', confidence: {}, overall: 'low' } as unknown as DB['staging'][number]['parsed'],
      rawSnippet: RAW,
      capturedAt: NOW,
    },
  ];
  const accepts: string[][] = [];
  const runs: AiRunInput[] = [];
  const api = {
    db,
    ai: {
      ready: options.ready ?? true,
      readyReason: options.reason ?? null,
      acceptSuggestions: (ids: string[]) => accepts.push(ids),
      rejectSuggestions: vi.fn(),
      clearRequestLog: vi.fn(),
      runScenario: async (input: AiRunInput): Promise<AiRunOutcome> => {
        runs.push(input);
        return options.run ? options.run(input) : { ok: true, kind: 'suggestions', created: 0 };
      },
    },
  } as unknown as AppApi;
  return { api, db, accepts, runs };
}

describe('AiScenarioPanel', () => {
  let container: HTMLDivElement;
  let root: Root;
  let closed: number;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    closed = 0;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(api: AppApi, scenario: 'd14' | 'd17' = 'd14'): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <AiScenarioPanel
          api={api}
          scenario={scenario}
          targetId={scenario === 'd14' ? 'exp-1' : 'st-1'}
          onClose={() => {
            closed += 1;
          }}
        />,
      );
    });
  }

  function byTestId(id: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${id}"]`);
  }

  /** React 受控输入：必须用原型上的 setter，否则 onChange 收不到值 */
  async function typeText(id: string, value: string): Promise<void> {
    const element = byTestId(id) as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function click(element: HTMLElement | null): Promise<void> {
    await act(async () => {
      element?.click();
      // 确认后 runScenario 是 async 的：等一个宏任务，让 promise 链跑完再断言
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('未配置：按钮置灰 + 内联原因，且不会发起请求', async () => {
    const { api, runs } = makeApi({ ready: false, reason: '尚未配置 AI 服务地址（设置 → AI 服务）' });
    await render(api);

    expect(byTestId('ai-blocked')?.textContent).toContain('尚未配置 AI 服务地址');
    const generate = byTestId('ai-generate') as HTMLButtonElement;
    expect(generate.disabled).toBe(true);

    await click(generate);
    expect(container.querySelector('[data-testid="send-preview"]')).toBeNull();
    expect(runs).toHaveLength(0);
  });

  it('D14：输入为空时不能预览；有内容后预览默认只勾「原文」→ 确认只发原文', async () => {
    const { api, runs } = makeApi();
    await render(api);

    expect((byTestId('ai-generate') as HTMLButtonElement).disabled).toBe(true);
    await typeText('ai-input', '一面问了 Vue 响应式原理，然后手写防抖');
    expect((byTestId('ai-generate') as HTMLButtonElement).disabled).toBe(false);

    await click(byTestId('ai-generate'));
    const preview = container.querySelector('[data-testid="send-preview"]');
    expect(preview).not.toBeNull();
    // 默认勾选：locked 原文勾上；公司名/岗位默认不勾（D14 只发粘贴文本）
    expect((container.querySelector('[data-testid="preview-field-note"] input') as HTMLInputElement).checked).toBe(true);
    expect((container.querySelector('[data-testid="preview-field-companyName"] input') as HTMLInputElement).checked).toBe(false);

    await click(byTestId('send-preview-confirm'));
    expect(runs).toHaveLength(1);
    expect(runs[0].checked).toEqual({ note: '一面问了 Vue 响应式原理，然后手写防抖' });
    expect(runs[0].scenario).toBe('d14');
    expect(runs[0].targetId).toBe('exp-1');
  });

  it('D17：锁定原文必发，携带的库内上下文默认不出境', async () => {
    const { api, runs } = makeApi();
    await render(api, 'd17');

    await click(byTestId('ai-generate'));
    expect((container.querySelector('[data-testid="preview-field-rawSnippet"] input') as HTMLInputElement).checked).toBe(true);
    expect((container.querySelector('[data-testid="preview-field-rawSnippet"] input') as HTMLInputElement).disabled).toBe(true);
    expect((container.querySelector('[data-testid="preview-field-companyName"] input') as HTMLInputElement).checked).toBe(false);

    await click(byTestId('send-preview-confirm'));
    expect(runs[0].checked).toEqual({ rawSnippet: RAW });
  });

  it('请求失败：只在面板里显示一行原因，不抛错、不弹窗', async () => {
    const { api } = makeApi({
      run: async () => ({ ok: false, error: '连不上 AI 服务：连接超时（10 秒）。地址要含 /v1。' }),
    });
    await render(api, 'd17');
    await click(byTestId('ai-generate'));
    await click(byTestId('send-preview-confirm'));

    expect(byTestId('ai-error')?.textContent).toContain('连不上 AI 服务');
    expect(container.querySelector('[data-testid="suggestion-list"]')).toBeNull();
  });

  it('成功：待确认建议出现 → 勾选后接受调用 acceptSuggestions 并关闭面板', async () => {
    const { api, db, accepts } = makeApi({
      run: async (input) => {
        const list = createSuggestions(
          [
            {
              pluginId: 'builtin:d17',
              targetType: 'staging_field',
              targetId: input.targetId,
              fieldPath: 'companyName',
              content: '字节跳动',
              evidence: '字节跳动 前端开发实习生',
            },
          ],
          NOW,
        );
        // 真实 App 走 mutate（cloneDB 产生新数组）；mock 这里也必须换引用，
        // 否则组件的 useMemo 依赖比较不到变化（这正是 mutate 纪律存在的理由）
        db.aiSuggestions = [...db.aiSuggestions, ...list];
        return { ok: true, kind: 'suggestions', created: list.length };
      },
    });
    await render(api, 'd17');
    await click(byTestId('ai-generate'));
    await click(byTestId('send-preview-confirm'));

    expect(container.querySelector('[data-testid="suggestion-list"]')).not.toBeNull();
    // D17 必须给证据对照
    expect(container.textContent).toContain('证据：字节跳动 前端开发实习生');

    await click(byTestId('suggestion-select-all'));
    await click(byTestId('suggestion-accept'));

    expect(accepts).toHaveLength(1);
    expect(accepts[0]).toHaveLength(1);
    expect(closed).toBe(1);
  });
});

/* ---------------------- v0.9 / T07：模块选择器 + 报告回调 ---------------------- */

const MODS: AiResumeModule[] = [
  {
    id: 'sec-exp',
    label: '实习经历',
    text: 'org: 字节跳动',
    primaryPath: 's:sec-exp:i:it-1:description',
    primaryText: '负责改写引擎',
    fieldPaths: { org: 's:sec-exp:i:it-1:org', description: 's:sec-exp:i:it-1:description' },
  },
  {
    id: 'sec-proj',
    label: '项目经历',
    text: 'projectName: 单文件简历工作台',
    primaryPath: 's:sec-proj:i:it-2:description',
    primaryText: '独立完成分页渲染',
    fieldPaths: { projectName: 's:sec-proj:i:it-2:projectName', description: 's:sec-proj:i:it-2:description' },
  },
  { id: 'sec-skill', label: '专业技能', text: 'skillsText: React', primaryPath: null, primaryText: '', fieldPaths: { skillsText: 's:sec-skill:i:it-3:skillsText' } },
  { id: 'sec-award', label: '奖项', text: 'awardName: 蓝桥杯省一', primaryPath: 's:sec-award:i:it-4:awardName', primaryText: '蓝桥杯省一', fieldPaths: { awardName: 's:sec-award:i:it-4:awardName' } },
];

describe('AiScenarioPanel · modulePicker（T07）', () => {
  let container: HTMLDivElement;
  let root: Root;
  let closed: number;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    closed = 0;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function byTestId(id: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${id}"]`);
  }

  async function renderD19(
    api: AppApi,
    scenario: 'd19-polish' | 'd19-diag' | 'd19-jd',
    onReport?: (reportId: string) => void,
  ): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <AiScenarioPanel
          api={api}
          scenario={scenario}
          targetId="res-1"
          modules={MODS}
          onReport={onReport}
          onClose={() => {
            closed += 1;
          }}
        />,
      );
    });
  }

  async function typeText(value: string): Promise<void> {
    const element = byTestId('ai-input') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function click(element: HTMLElement | null): Promise<void> {
    await act(async () => {
      element?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function moduleBox(index: number): HTMLInputElement {
    return container.querySelectorAll('.ai-modules__item input')[index] as HTMLInputElement;
  }

  it('润色单选：不勾不能预览；勾第二个会顶掉第一个（写回目标只有一个）', async () => {
    const { api } = makeApi();
    await renderD19(api, 'd19-polish');

    expect((byTestId('ai-generate') as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain('先勾一个板块');

    await click(moduleBox(0));
    expect(moduleBox(0).checked).toBe(true);
    expect((byTestId('ai-generate') as HTMLButtonElement).disabled).toBe(false);

    await click(moduleBox(1));
    expect(moduleBox(0).checked).toBe(false);
    expect(moduleBox(1).checked).toBe(true);
  });

  it('没有可润色文本的板块（primaryPath=null）：提示 + 不能预览', async () => {
    const { api } = makeApi();
    await renderD19(api, 'd19-polish');
    await click(moduleBox(2)); // 技能板块没有 bullets / 主文本
    expect(container.textContent).toContain('没有可润色的文本');
    expect((byTestId('ai-generate') as HTMLButtonElement).disabled).toBe(true);
  });

  it('诊断多选：勾满 3 个后第 4 个勾不上（PRD §10.1 上限）', async () => {
    const { api } = makeApi();
    await renderD19(api, 'd19-diag');
    await typeText('前端开发实习生');

    await click(moduleBox(0));
    await click(moduleBox(1));
    await click(moduleBox(2));
    expect(moduleBox(0).checked && moduleBox(1).checked && moduleBox(2).checked).toBe(true);
    await click(moduleBox(3));
    expect(moduleBox(3).checked).toBe(false);
  });

  it('确认发送：polish 的 fieldPath 是 {polished: 主路径}，checked 带选中段原文；多选合并各模块 fieldPaths', async () => {
    const { api, runs } = makeApi();
    await renderD19(api, 'd19-polish');
    await click(moduleBox(0));
    await click(byTestId('ai-generate'));
    await click(byTestId('send-preview-confirm'));

    expect(runs).toHaveLength(1);
    expect(runs[0].context?.fieldPaths).toEqual({ polished: 's:sec-exp:i:it-1:description' });
    expect(runs[0].checked.selectedText).toBe('负责改写引擎');
    expect(runs[0].checked.sectionLabel).toBe('实习经历');

    const { api: api2, runs: runs2 } = makeApi();
    await renderD19(api2, 'd19-diag');
    await typeText('前端开发实习生');
    await click(moduleBox(0));
    await click(moduleBox(1));
    await click(byTestId('ai-generate'));
    // d19-diag 的目标岗位名默认勾选（defaultChecked:true）
    expect(
      (container.querySelector('[data-testid="preview-field-targetJobTitle"] input') as HTMLInputElement).checked,
    ).toBe(true);
    await click(byTestId('send-preview-confirm'));

    expect(runs2[0].context?.fieldPaths).toEqual({
      org: 's:sec-exp:i:it-1:org',
      description: 's:sec-proj:i:it-2:description',
      projectName: 's:sec-proj:i:it-2:projectName',
    });
    expect(runs2[0].checked.selectedModules).toContain('【实习经历】');
  });

  it('报告场景：outcome kind=report → onReport(reportId) + 自动关面板', async () => {
    const { api } = makeApi({ run: async () => ({ ok: true, kind: 'report', reportId: 'rep_9' }) });
    const reported: string[] = [];
    await renderD19(api, 'd19-diag', (reportId) => reported.push(reportId));
    await typeText('前端开发实习生');
    await click(moduleBox(0));
    await click(byTestId('ai-generate'));
    await click(byTestId('send-preview-confirm'));

    expect(reported).toEqual(['rep_9']);
    expect(closed).toBe(1);
  });
});
