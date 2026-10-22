/**
 * 三个内置 AI 场景的运行时单测（v0.8 / T05：D14 / D15 / D17）。
 *
 * 这里盯的是两件最容易在重构里悄悄破掉的事：
 * ① **请求消息只由勾选字段拼成**（验收 11：D17 出境内容必须一字不差等于粘贴原文）；
 * ② **模型输出必须过窄校验**（解析失败 = 零写入 + 一句人话，绝不猜）。
 * 网络层不在这里测 —— gateway.test.ts 用注入的 mock fetch 覆盖，本项目测试从不真实联网。
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_AI_QUESTIONS,
  buildScenarioMessages,
  parseScenarioOutput,
  scenarioPluginId,
  scenarioPreviewFields,
  toNewSuggestions,
} from './scenarios';

const RAW = '字节跳动 前端开发实习生 25k·北京 已投递 3/12 更新';

describe('scenarios · 出境字段声明', () => {
  it('D14：粘贴原文是唯一默认出境项，公司名/岗位显式默认不勾', () => {
    const fields = scenarioPreviewFields('d14', { note: '一面问了 Vue', companyName: '字节' });
    const note = fields.find((field) => field.name === 'note');
    expect(note?.locked).toBe(true);
    expect(note?.value).toBe('一面问了 Vue');
    // 显式 defaultChecked:false 会覆盖全局基线（companyName 本来在基线里）
    expect(fields.find((field) => field.name === 'companyName')?.defaultChecked).toBe(false);
    expect(fields.find((field) => field.name === 'jobTitle')?.defaultChecked).toBe(false);
  });

  it('D17：原文 locked；「已识别部分」默认不勾（只发原文）', () => {
    const fields = scenarioPreviewFields('d17', { rawSnippet: RAW, companyName: '字节' });
    expect(fields.find((field) => field.name === 'rawSnippet')?.locked).toBe(true);
    for (const name of ['companyName', 'jobTitle', 'status']) {
      expect(fields.find((field) => field.name === name)?.defaultChecked).toBe(false);
    }
  });

  it('D15：轮次/面试类型/面试官/沟通记录是显式追加项（未声明 defaultChecked）', () => {
    const fields = scenarioPreviewFields('d15', { companyName: '字节', round: '第 2 轮' });
    expect(fields.map((field) => field.name)).toEqual([
      'companyName',
      'jobTitle',
      'status',
      'round',
      'interviewKind',
      'interviewer',
      'lastNote',
    ]);
    for (const name of ['round', 'interviewKind', 'interviewer', 'lastNote']) {
      // 未声明 = 走全局基线（companyName/jobTitle/status），这四项就落在「默认不勾」
      expect(fields.find((field) => field.name === name)?.defaultChecked).toBeUndefined();
    }
  });

  it('scenarioPluginId 与 prompts 的 builtin 命名空间一致', () => {
    expect(scenarioPluginId('d14')).toBe('builtin:d14');
    expect(scenarioPluginId('d15')).toBe('builtin:d15');
    expect(scenarioPluginId('d17')).toBe('builtin:d17');
  });
});

describe('scenarios · 请求消息（只发勾选内容）', () => {
  it('D17：user 消息一字不差等于粘贴原文，且不含任何库内数据', () => {
    const messages = buildScenarioMessages('d17', { rawSnippet: RAW });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1]).toEqual({ role: 'user', content: RAW });
    // 出境内容只有一个 user 消息：除原文之外没有第二个字段的位置
    expect(messages).toHaveLength(2);
    expect(Object.keys(messages[1])).toEqual(['role', 'content']);
  });

  it('D17：未勾选的「已识别部分」绝不进请求体', () => {
    const messages = buildScenarioMessages('d17', { rawSnippet: RAW, companyName: '字节跳动' });
    // D17 的 user 消息恒为原文：即便调用方多塞了值，也不会被拼进去
    expect(messages[1].content).toBe(RAW);
  });

  it('D14：只有勾选的字段进消息，按声明顺序、空值跳过', () => {
    const messages = buildScenarioMessages('d14', { note: '一面问了 Vue', jobTitle: '' });
    expect(messages[1].content).toBe('面经笔记原文：一面问了 Vue');
    const withCompany = buildScenarioMessages('d14', { note: '一面问了 Vue', companyName: '字节' });
    expect(withCompany[1].content).toBe('面经笔记原文：一面问了 Vue\n公司名：字节');
  });

  it('D15：默认三项之外的字段未勾选就不出现', () => {
    const messages = buildScenarioMessages('d15', {
      companyName: '字节',
      jobTitle: '前端',
      status: '沟通中',
      round: '',
      interviewer: '',
    });
    expect(messages[1].content).toBe('公司名：字节\n岗位名：前端\n当前状态：沟通中');
  });
});

describe('scenarios · D14 解析', () => {
  it('约定 JSON → 逐题建议（围栏与前后废话都容忍）', () => {
    const raw = '```json\n{"questions":[{"text":"Vue 响应式原理","category":"concept"},{"text":"手写防抖","category":"algo"}]}\n```';
    const parsed = parseScenarioOutput('d14', raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.items).toEqual([
      { field: 'text', value: 'Vue 响应式原理' },
      { field: 'text', value: '手写防抖' },
    ]);
  });

  it('模型不按 JSON 时按「一行一题」兜底，丢掉类别后缀与项目符号', () => {
    const raw = '1. Vue 响应式原理 | concept\n- 手写防抖 | algo\n\n2) 反问环节';
    const parsed = parseScenarioOutput('d14', raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.items.map((item) => item.value)).toEqual(['Vue 响应式原理', '手写防抖', '反问环节']);
  });

  it('空输出 → 诚实报错（不假装成功）', () => {
    const parsed = parseScenarioOutput('d14', '   \n  \n');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('没有从这段文字里认出题目');
  });

  it('题目数量有上限（防止整段笔记被拆成上百行）', () => {
    const raw = Array.from({ length: MAX_AI_QUESTIONS + 5 }, (_, index) => `第 ${index} 题`).join('\n');
    const parsed = parseScenarioOutput('d14', raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.items).toHaveLength(MAX_AI_QUESTIONS);
  });
});

describe('scenarios · D15 解析', () => {
  it('约定 JSON → 一条话术，field = content（写备注用）', () => {
    const parsed = parseScenarioOutput('d15', '{"draft":"您好，我是上周三投递前端岗的…"}');
    expect(parsed).toEqual({ ok: true, items: [{ field: 'content', value: '您好，我是上周三投递前端岗的…' }] });
  });

  it('模型直接回纯文本也接受', () => {
    const parsed = parseScenarioOutput('d15', '```\n您好，想跟进一下流程～\n```');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.items[0].value).toBe('您好，想跟进一下流程～');
  });

  it('空输出 → 报错（不落一条空备注）', () => {
    const parsed = parseScenarioOutput('d15', '{"draft":"   "}');
    expect(parsed.ok).toBe(false);
  });
});

describe('scenarios · D17 解析（窄校验 + 证据）', () => {
  it('约定 JSON → 逐字段建议，保留证据片段', () => {
    const raw = JSON.stringify({
      fields: [
        { field: 'companyName', value: '字节跳动', evidence: '字节跳动 前端开发实习生' },
        { field: 'status', value: '已投递', evidence: '3/12 已投递' },
      ],
    });
    const parsed = parseScenarioOutput('d17', raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.items).toEqual([
      { field: 'companyName', value: '字节跳动', evidence: '字节跳动 前端开发实习生' },
      { field: 'status', value: '已投递', evidence: '3/12 已投递' },
    ]);
  });

  it('白名单外的字段、空值、重复字段一律丢（不猜）', () => {
    const raw = JSON.stringify({
      fields: [
        { field: 'companyName', value: '字节跳动' },
        { field: 'companyName', value: '重复值' },
        { field: 'jdText', value: '不该被写入的长文本' },
        { field: 'jobTitle', value: '   ' },
        { field: 'city', value: '北京' },
      ],
    });
    const parsed = parseScenarioOutput('d17', raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.items).toEqual([
      { field: 'companyName', value: '字节跳动' },
      { field: 'city', value: '北京' },
    ]);
  });

  it('不是约定 JSON → 报错且明说「没有写入任何字段」', () => {
    const parsed = parseScenarioOutput('d17', '抱歉，我无法从这段文字里识别出公司名。');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('没有写入任何字段');
  });

  it('JSON 里一个可用字段都没有 → 报错（不写入空建议）', () => {
    const parsed = parseScenarioOutput('d17', '{"fields":[{"field":"unknown","value":"x"}]}');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('未写入任何内容');
  });
});

describe('scenarios · 建议映射', () => {
  it('D14 → targetType=question / targetId 为面经 id / fieldPath=text', () => {
    const list = toNewSuggestions('d14', 'exp-1', [{ field: 'text', value: 'Vue 响应式原理' }]);
    expect(list).toEqual([
      {
        pluginId: 'builtin:d14',
        targetType: 'question',
        targetId: 'exp-1',
        fieldPath: 'text',
        content: 'Vue 响应式原理',
      },
    ]);
  });

  it('D17 → targetType=staging_field / targetId 为暂存行 / 带 evidence', () => {
    const list = toNewSuggestions('d17', 'st-1', [{ field: 'companyName', value: '字节跳动', evidence: '原文' }]);
    expect(list[0]).toMatchObject({
      pluginId: 'builtin:d17',
      targetType: 'staging_field',
      targetId: 'st-1',
      fieldPath: 'companyName',
      content: '字节跳动',
      evidence: '原文',
    });
  });
});

/* ---------------------- v0.9 / T07 四场景 ---------------------- */

describe('scenarios · T07 四场景出境表（字段表就是白名单）', () => {
  it('四个场景的出境字段逐一对齐 PRD §10', () => {
    expect(scenarioPreviewFields('d19-diag', {}).map((field) => field.name)).toEqual(['selectedModules', 'targetJobTitle']);
    expect(scenarioPreviewFields('d19-polish', {}).map((field) => field.name)).toEqual(['selectedText', 'sectionLabel']);
    expect(scenarioPreviewFields('d19-jd', {}).map((field) => field.name)).toEqual(['jdText', 'selectedModules']);
    expect(scenarioPreviewFields('d20-analysis', {}).map((field) => field.name)).toEqual([
      'jdText',
      'companyName',
      'jobTitle',
      'status',
    ]);
  });

  it('★ 联系类字段绝不出境：四场景字段表里没有姓名/电话/邮箱/照片/城市', () => {
    for (const key of ['d19-diag', 'd19-polish', 'd19-jd', 'd20-analysis'] as const) {
      const names = scenarioPreviewFields(key, {}).map((field) => field.name);
      for (const banned of ['name', 'phone', 'email', 'photo', 'city']) {
        expect(names, `${key} 不应包含 ${banned}`).not.toContain(banned);
      }
    }
  });

  it('d19-polish 只发选中段 + 板块名；d20 只发 JD/公司/岗位/状态', () => {
    const polish = buildScenarioMessages('d19-polish', { selectedText: '负责改写引擎', sectionLabel: '实习经历' });
    expect(polish[0].role).toBe('system');
    expect(polish[1].content).toContain('选中段落原文：负责改写引擎');
    expect(polish[1].content).toContain('所属板块：实习经历');

    const d20 = buildScenarioMessages('d20-analysis', {
      jdText: 'JD 原文',
      companyName: '字节跳动',
      jobTitle: '前端开发实习生',
      status: '已投递',
    });
    expect(d20[1].content).toContain('JD 留档原文：JD 原文');
    expect(d20[1].content).toContain('公司名：字节跳动');
    expect(d20[1].content).toContain('岗位名：前端开发实习生');
    expect(d20[1].content).toContain('当前状态：已投递');
  });

  it('d19-diag 的报告场景被挡在建议解析之外（防误接：静默写错表比报错严重）', () => {
    const result = parseScenarioOutput('d19-diag', JSON.stringify({ content: '报告' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('报告');
    expect(toNewSuggestions('d19-diag', 'res-1', [])).toEqual([]);
  });
});

describe('scenarios · d19-polish 解析', () => {
  it('polished + reasons 并成证据行（join「；」，截 300）', () => {
    const result = parseScenarioOutput(
      'd19-polish',
      JSON.stringify({ polished: '主导改写引擎重构', reasons: ['动词开头', '带数字'] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]).toEqual({ field: 'polished', value: '主导改写引擎重构', evidence: '动词开头；带数字' });
  });

  it('没有 polished → ok:false（诚实报错，零写入）', () => {
    expect(parseScenarioOutput('d19-polish', JSON.stringify({ reasons: ['只有理由'] })).ok).toBe(false);
  });
});

describe('scenarios · d19-jd 解析', () => {
  it('fieldPath 键去重 + evidence 保留；超过 10 条只收前 10 条', () => {
    const suggestions = Array.from({ length: 14 }, (_, i) => ({
      fieldPath: i % 3 === 0 ? 'description' : `key-${i}`,
      content: `改写 ${i}`,
      evidence: 'JD 原句',
    }));
    const result = parseScenarioOutput('d19-jd', JSON.stringify({ suggestions }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(10);
    expect(result.items[0].field).toBe('description');
    // 第二条 description 是重复键，被丢
    expect(result.items[1].field).toBe('key-1');
    expect(result.items[0].evidence).toBe('JD 原句');
  });

  it('非约定形状 → ok:false', () => {
    expect(parseScenarioOutput('d19-jd', '随便一段话').ok).toBe(false);
  });
});
